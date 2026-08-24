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

async fn git_output(state: &State<'_, WorkspaceDirectoryState>, args: &[&str]) -> Result<String, &'static str> {
    let workspace = state.0.lock().map_err(|_| "github-workspace-unavailable")?.clone().ok_or("github-workspace-not-selected")?;
    let output = Command::new("git").args(args).current_dir(workspace).stdin(Stdio::null()).output().await.map_err(|_| "github-git-unavailable")?;
    if !output.status.success() { return Err("github-git-command-failed"); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[tauri::command]
pub async fn github_test_token(token: String) -> Result<GithubIdentity, &'static str> {
    if !valid_token(&token) { return Err("github-token-invalid"); }
    let response = reqwest::Client::new().get("https://api.github.com/user").header("User-Agent", "AI-Work-OS").bearer_auth(token.trim()).send().await.map_err(|_| "github-network-failed")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED { return Err("github-token-rejected"); }
    if !response.status().is_success() { return Err("github-api-failed"); }
    let body: serde_json::Value = response.json().await.map_err(|_| "github-api-invalid")?;
    let login = body.get("login").and_then(|value| value.as_str()).filter(|value| !value.is_empty()).ok_or("github-api-invalid")?.to_owned();
    let name = body.get("name").and_then(|value| value.as_str()).filter(|value| !value.is_empty()).map(str::to_owned);
    Ok(GithubIdentity { login, name })
}

#[tauri::command]
pub async fn github_workspace_status(state: State<'_, WorkspaceDirectoryState>) -> Result<GithubWorkspaceStatus, &'static str> {
    let branch = git_output(&state, &["branch", "--show-current"]).await?;
    let changes = git_output(&state, &["status", "--short"]).await?;
    let diff_stat = git_output(&state, &["diff", "--stat"]).await?;
    Ok(GithubWorkspaceStatus { selected: true, branch, changes, diff_stat })
}

#[tauri::command]
pub async fn github_workspace_preflight(state: State<'_, WorkspaceDirectoryState>) -> Result<GithubWorkspacePreflight, &'static str> {
    let workspace = state.0.lock().map_err(|_| "github-workspace-unavailable")?.clone().ok_or("github-workspace-not-selected")?;
    let output = Command::new("git").args(["diff", "--check"]).current_dir(workspace).stdin(Stdio::null()).output().await.map_err(|_| "github-git-unavailable")?;
    let detail = String::from_utf8_lossy(if output.status.success() { &output.stdout } else { &output.stderr }).trim().chars().take(4_000).collect::<String>();
    Ok(GithubWorkspacePreflight { passed: output.status.success(), command: "git diff --check", detail: if detail.is_empty() && output.status.success() { "未发现空白或冲突标记问题。".to_owned() } else { detail } })
}

#[tauri::command]
pub async fn github_commit_and_push(state: State<'_, WorkspaceDirectoryState>, token: String, message: String, confirmed: bool) -> Result<GithubWorkspaceStatus, &'static str> {
    if !confirmed { return Err("github-push-requires-confirmation"); }
    if !valid_token(&token) { return Err("github-token-invalid"); }
    let commit_message = message.trim();
    if commit_message.is_empty() || commit_message.len() > 240 { return Err("github-commit-message-invalid"); }
    let workspace = state.0.lock().map_err(|_| "github-workspace-unavailable")?.clone().ok_or("github-workspace-not-selected")?;
    let status = git_output(&state, &["status", "--short"]).await?;
    if status.trim().is_empty() { return Err("github-no-local-changes"); }
    let add = Command::new("git").args(["add", "-A"]).current_dir(&workspace).stdin(Stdio::null()).output().await.map_err(|_| "github-git-unavailable")?;
    if !add.status.success() { return Err("github-git-add-failed"); }
    let commit = Command::new("git").args(["commit", "-m", commit_message]).current_dir(&workspace).stdin(Stdio::null()).output().await.map_err(|_| "github-git-unavailable")?;
    if !commit.status.success() { return Err("github-git-commit-failed"); }
    let authorization = format!("AUTHORIZATION: basic {}", STANDARD.encode(format!("x-access-token:{}", token.trim())));
    let push = Command::new("git")
        .args(["push", "origin", "HEAD"])
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", authorization)
        .output()
        .await
        .map_err(|_| "github-git-unavailable")?;
    if !push.status.success() { return Err("github-git-push-failed"); }
    github_workspace_status(state).await
}

#[cfg(test)]
mod tests {
    use super::valid_token;

    #[test]
    fn accepts_long_non_whitespace_personal_access_tokens() {
        assert!(valid_token("github_pat_0123456789abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn rejects_short_or_whitespace_tokens() {
        assert!(!valid_token("too-short"));
        assert!(!valid_token("github_pat_with whitespace"));
    }
}
