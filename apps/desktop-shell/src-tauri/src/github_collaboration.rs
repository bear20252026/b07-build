use crate::WorkspaceDirectoryState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::process::Stdio;
use tauri::State;
use tokio::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIdentity {
    pub login: String,
    pub name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubWorkspaceStatus {
    pub selected: bool,
    pub branch: String,
    pub changes: String,
    pub diff_stat: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubWorkspacePreflight {
    pub passed: bool,
    pub command: &'static str,
    pub detail: String,
}

fn valid_token(token: &str) -> bool {
    let value = token.trim();
    value.len() >= 20 && value.len() <= 4096 && !value.chars().any(char::is_whitespace)
}

/// 推送前检查已暂存文件名里的秘密凭据形态（SEC-010）。
///
/// `git add -A` 会把一切工作区改动都收进来；`git push` 只看提交不看语义。
/// 在 add 与 commit 之间加一道文件名哨兵：`.env` / 私钥 / 证书这类文件
/// 一旦被暂存就整次推送失败，让用户显式处理，而不是赌用户记得加 .gitignore。
const SENSITIVE_STAGED_SUFFIXES: &[&str] = &[
    ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
];
const SENSITIVE_STAGED_NAMES: &[&str] = &[
    ".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json", "secrets.json",
    ".npmrc", ".netrc",
];

fn sensitive_staged_file(staged: &str) -> bool {
    for line in staged.lines() {
        // `git diff --cached --name-only` 的每行是一个相对路径；重命名行带 \t 分隔，取最后一段。
        let path = line.trim().rsplit('\t').next().unwrap_or(line.trim());
        let lowered = path.trim_matches('"').to_ascii_lowercase();
        let name = lowered.rsplit('/').next().unwrap_or(lowered.as_str());
        if SENSITIVE_STAGED_NAMES.contains(&name) {
            return true;
        }
        if SENSITIVE_STAGED_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix))
        {
            return true;
        }
    }
    false
}

async fn git_output(
    state: &State<'_, WorkspaceDirectoryState>,
    args: &[&str],
) -> Result<String, &'static str> {
    let workspace = state
        .0
        .lock()
        .map_err(|_| "github-workspace-unavailable")?
        .clone()
        .ok_or("github-workspace-not-selected")?;
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "github-git-unavailable")?;
    if !output.status.success() {
        return Err("github-git-command-failed");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[tauri::command]
pub async fn github_test_token(token: String) -> Result<GithubIdentity, &'static str> {
    if !valid_token(&token) {
        return Err("github-token-invalid");
    }
    let response = reqwest::Client::new()
        .get("https://api.github.com/user")
        .header("User-Agent", "AI-Work-OS")
        .bearer_auth(token.trim())
        .send()
        .await
        .map_err(|_| "github-network-failed")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("github-token-rejected");
    }
    if !response.status().is_success() {
        return Err("github-api-failed");
    }
    let body: serde_json::Value = response.json().await.map_err(|_| "github-api-invalid")?;
    let login = body
        .get("login")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or("github-api-invalid")?
        .to_owned();
    let name = body
        .get("name")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Ok(GithubIdentity { login, name })
}

#[tauri::command]
pub async fn github_workspace_status(
    state: State<'_, WorkspaceDirectoryState>,
) -> Result<GithubWorkspaceStatus, &'static str> {
    let branch = git_output(&state, &["branch", "--show-current"]).await?;
    let changes = git_output(&state, &["status", "--short"]).await?;
    let diff_stat = git_output(&state, &["diff", "--stat"]).await?;
    Ok(GithubWorkspaceStatus {
        selected: true,
        branch,
        changes,
        diff_stat,
    })
}

#[tauri::command]
pub async fn github_workspace_preflight(
    state: State<'_, WorkspaceDirectoryState>,
) -> Result<GithubWorkspacePreflight, &'static str> {
    let workspace = state
        .0
        .lock()
        .map_err(|_| "github-workspace-unavailable")?
        .clone()
        .ok_or("github-workspace-not-selected")?;
    let output = Command::new("git")
        .args(["diff", "--check"])
        .current_dir(workspace)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "github-git-unavailable")?;
    let detail = String::from_utf8_lossy(if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    })
    .trim()
    .chars()
    .take(4_000)
    .collect::<String>();
    Ok(GithubWorkspacePreflight {
        passed: output.status.success(),
        command: "git diff --check",
        detail: if detail.is_empty() && output.status.success() {
            "未发现空白或冲突标记问题。".to_owned()
        } else {
            detail
        },
    })
}

#[tauri::command]
pub async fn github_commit_and_push(
    state: State<'_, WorkspaceDirectoryState>,
    token: String,
    message: String,
    confirmed: bool,
) -> Result<GithubWorkspaceStatus, &'static str> {
    if !confirmed {
        return Err("github-push-requires-confirmation");
    }
    if !valid_token(&token) {
        return Err("github-token-invalid");
    }
    let commit_message = message.trim();
    if commit_message.is_empty() || commit_message.len() > 240 {
        return Err("github-commit-message-invalid");
    }
    let workspace = state
        .0
        .lock()
        .map_err(|_| "github-workspace-unavailable")?
        .clone()
        .ok_or("github-workspace-not-selected")?;
    let status = git_output(&state, &["status", "--short"]).await?;
    if status.trim().is_empty() {
        return Err("github-no-local-changes");
    }
    let add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "github-git-unavailable")?;
    if !add.status.success() {
        return Err("github-git-add-failed");
    }
    // SEC-010：add -A 之后、commit 之前检查一遍刚暂存了什么。
    // 秘密文件一旦进了提交，删除历史就是一场公开事故；这里直接拦在门内。
    let staged = Command::new("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "github-git-unavailable")?;
    if !staged.status.success() {
        return Err("github-git-unavailable");
    }
    if sensitive_staged_file(&String::from_utf8_lossy(&staged.stdout)) {
        return Err("github-push-sensitive-files-staged");
    }
    // SEC-003 配套：commit 与 push 都加 --no-verify。
    // 令牌经环境变量进入 git 进程，而 pre-commit / pre-push hook 是**被推送仓库里
    // 的任意脚本**——不允许它在持有令牌的环境里执行。我们自己的确认流程
    // （confirmed 参数）就是这里的人工闸门，不依赖仓库内的 hook。
    let commit = Command::new("git")
        .args(["commit", "--no-verify", "-m", commit_message])
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|_| "github-git-unavailable")?;
    if !commit.status.success() {
        return Err("github-git-commit-failed");
    }
    let authorization = format!(
        "AUTHORIZATION: basic {}",
        STANDARD.encode(format!("x-access-token:{}", token.trim()))
    );
    let push = Command::new("git")
        .args(["push", "--no-verify", "origin", "HEAD"])
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", authorization)
        .output()
        .await
        .map_err(|_| "github-git-unavailable")?;
    if !push.status.success() {
        return Err("github-git-push-failed");
    }
    github_workspace_status(state).await
}

#[cfg(test)]
mod tests {
    use super::{sensitive_staged_file, valid_token};

    #[test]
    fn accepts_long_non_whitespace_personal_access_tokens() {
        assert!(valid_token(
            "github_pat_0123456789abcdefghijklmnopqrstuvwxyz"
        ));
    }

    #[test]
    fn rejects_short_or_whitespace_tokens() {
        assert!(!valid_token("too-short"));
        assert!(!valid_token("github_pat_with whitespace"));
    }

    #[test]
    fn staged_secret_files_are_flagged() {
        assert!(sensitive_staged_file(".env\nsrc/main.rs"));
        assert!(sensitive_staged_file("src/main.rs\nconfig/server.pem"));
        assert!(sensitive_staged_file("keys/id_rsa"));
        assert!(sensitive_staged_file("deploy/keystore.jks"));
        assert!(sensitive_staged_file("old\tsrc/.env"));
        assert!(sensitive_staged_file("home/.npmrc"));
        // 普通源码不得误伤。
        assert!(!sensitive_staged_file("src/main.rs\npackages/ui/src/index.ts"));
        assert!(!sensitive_staged_file("README.md"));
    }
}
