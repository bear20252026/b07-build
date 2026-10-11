use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{sleep, Duration},
};

type SharedChild = Arc<Mutex<Child>>;
type RunMap = Arc<Mutex<HashMap<String, SharedChild>>>;

pub struct TerminalRunState(pub RunMap);

impl TerminalRunState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminalCommandRequest {
    pub run_id: String,
    pub command: String,
    pub confirm_dangerous: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTerminalCommandRequest {
    pub run_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResponse {
    pub run_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    run_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDoneEvent {
    run_id: String,
    exit_code: Option<i32>,
    cancelled: bool,
    error: Option<String>,
}

fn valid_run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

/// 允许执行的可执行文件名。终端只用于构建、测试与查看，不用于系统管理。
///
/// 这里刻意用「白名单」而不是「危险名单」：危险名单永远补不完，
/// 而漏掉一个白名单条目最坏的结果只是某个命令跑不了。
const ALLOWED_EXECUTABLES: &[&str] = &[
    // 版本控制
    "git", // Node 生态
    "npm", "npx", "pnpm", "yarn", "node", "bun", "deno", // Rust
    "cargo", "rustc", "rustup", // Python
    "python", "python3", "pip", "pip3", "uv", "poetry", "pytest",
    // 其它语言工具链
    "go", "java", "mvn", "gradle", "dotnet", "make", "cmake", // 检查与测试
    "ls", "dir", "cat", "type", "echo", "pwd", "find", "grep", "rg", "head", "tail", "wc", "tree",
    "which", "where", "env", "whoami", "tsc", "tsx", "eslint", "prettier", "vitest", "jest",
    "ruff", "mypy",
];

/// 无论可执行文件是否在白名单内都绝不执行的片段。这些是会丢数据或改系统状态的操作，
/// `confirm_dangerous` 也不能放行——它们根本不该出现在一条命令里。
const DENIED_PATTERNS: &[&str] = &[
    "rm -rf",
    "rm -fr",
    "rmdir /",
    "del /",
    "del /f",
    "remove-item -recurse",
    "format ",
    "mkfs",
    "diskpart",
    "dd if=",
    "shutdown",
    "restart-computer",
    "stop-computer",
    "stop-process -force",
    "taskkill",
    "reg delete",
    "reg add",
    "net user",
    "schtasks",
    "runas",
    "-verb runas",
    "sudo",
    "git push --force",
    "git push -f",
    "chmod 777",
    "set-executionpolicy",
    "iex(",
    "invoke-expression",
    "curl | sh",
    "wget | sh",
    "| sh",
    "| bash",
    "| powershell",
    "| cmd",
];

/// 允许执行但会改变仓库或对外发布状态的片段：需要调用方显式确认。
const CONFIRMATION_PATTERNS: &[&str] = &[
    "git push",
    "git reset --hard",
    "git clean",
    "npm publish",
    "cargo publish",
];

/// 不允许命令拼接与重定向。一条命令就是一条命令：
/// `npm test && rm -rf x` 这类组合会让白名单完全失效。
const FORBIDDEN_OPERATORS: &[&str] = &["&&", "||", ";", "\n", "\r", "`", "$(", ">"];

/// 取出命令的首个词作为可执行文件名。带路径或引号包裹的一律不认，
/// 否则 `C:\Windows\System32\format` 之类能绕过白名单。
fn executable_name(command: &str) -> Option<String> {
    let first = command
        .split_whitespace()
        .next()?
        .trim_matches(|ch| ch == '"' || ch == '\'');
    if first.is_empty() || first.contains('/') || first.contains('\\') || first.contains(':') {
        return None;
    }
    Some(first.to_ascii_lowercase())
}

/// 命令准入判定：返回 Some(错误码) 表示拒绝执行。
/// 顺序很重要——先硬拒绝、再禁止拼接、最后才看白名单。
fn command_denial(command: &str) -> Option<&'static str> {
    let value = command.to_ascii_lowercase();
    if DENIED_PATTERNS.iter().any(|needle| value.contains(needle)) {
        return Some("terminal-command-denied");
    }
    if FORBIDDEN_OPERATORS
        .iter()
        .any(|needle| value.contains(needle))
    {
        return Some("terminal-command-chaining-denied");
    }
    match executable_name(command) {
        Some(name) if ALLOWED_EXECUTABLES.contains(&name.as_str()) => None,
        _ => Some("terminal-command-not-allowed"),
    }
}

fn requires_confirmation(command: &str) -> bool {
    let value = command.to_ascii_lowercase();
    CONFIRMATION_PATTERNS
        .iter()
        .any(|needle| value.contains(needle))
}

fn command_for(command: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut process = Command::new("cmd");
        process.args(["/C", command]);
        process
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        process
    }
}

async fn relay_lines<R>(app: AppHandle, run_id: String, stream: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => return,
            Ok(_) => {
                let _ = app.emit(
                    "terminal-command-output",
                    TerminalOutputEvent {
                        run_id: run_id.clone(),
                        stream,
                        text: line.clone(),
                    },
                );
            }
            Err(_) => return,
        }
    }
}

#[tauri::command]
pub async fn start_terminal_command(
    app: AppHandle,
    state: State<'_, TerminalRunState>,
    request: StartTerminalCommandRequest,
) -> Result<TerminalStartResponse, &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("terminal-run-id-invalid");
    }
    let command = request.command.trim();
    if command.is_empty() || command.len() > 16_000 {
        return Err("terminal-command-invalid");
    }
    // 白名单准入：不在名单上的命令根本不启动进程，而不是先跑起来再看后果。
    if let Some(denial) = command_denial(command) {
        return Err(denial);
    }
    if requires_confirmation(command) && !request.confirm_dangerous {
        return Err("terminal-command-confirmation-required");
    }
    if state.0.lock().await.contains_key(&request.run_id) {
        return Err("terminal-run-already-active");
    }
    let mut process = command_for(command);
    process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = process
        .spawn()
        .map_err(|_| "terminal-command-spawn-failed")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("terminal-command-output-unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("terminal-command-output-unavailable")?;
    let run_id = request.run_id.clone();
    let child = Arc::new(Mutex::new(child));
    state.0.lock().await.insert(run_id.clone(), child.clone());
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stdout", stdout));
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stderr", stderr));
    let runs = state.0.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = {
                let mut process = child.lock().await;
                process.try_wait()
            };
            match status {
                Ok(Some(status)) => {
                    runs.lock().await.remove(&run_id);
                    let _ = app.emit(
                        "terminal-command-done",
                        TerminalDoneEvent {
                            run_id,
                            exit_code: status.code(),
                            cancelled: false,
                            error: None,
                        },
                    );
                    return;
                }
                Ok(None) => sleep(Duration::from_millis(120)).await,
                Err(_) => {
                    runs.lock().await.remove(&run_id);
                    let _ = app.emit(
                        "terminal-command-done",
                        TerminalDoneEvent {
                            run_id,
                            exit_code: None,
                            cancelled: false,
                            error: Some("terminal-command-status-failed".to_owned()),
                        },
                    );
                    return;
                }
            }
        }
    });
    Ok(TerminalStartResponse {
        run_id: request.run_id,
    })
}

#[tauri::command]
pub async fn cancel_terminal_command(
    app: AppHandle,
    state: State<'_, TerminalRunState>,
    request: CancelTerminalCommandRequest,
) -> Result<(), &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("terminal-run-id-invalid");
    }
    let child = state
        .0
        .lock()
        .await
        .get(&request.run_id)
        .cloned()
        .ok_or("terminal-run-not-found")?;
    let result = child.lock().await.start_kill();
    if result.is_err() {
        return Err("terminal-command-cancel-failed");
    }
    let _ = app.emit(
        "terminal-command-done",
        TerminalDoneEvent {
            run_id: request.run_id,
            exit_code: None,
            cancelled: true,
            error: None,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{command_denial, executable_name, requires_confirmation, valid_run_id};

    #[test]
    fn allows_build_test_and_inspection_commands() {
        for command in [
            "npm test",
            "cargo build --release",
            "git status",
            "python -m pytest",
            "ls -la",
            "rg TODO src",
        ] {
            assert_eq!(command_denial(command), None, "应当允许：{command}");
        }
    }

    #[test]
    fn rejects_executables_outside_the_allowlist() {
        for command in [
            "curl https://example.com",
            "powershell Get-Process",
            "bash script.sh",
            "tccutil reset",
        ] {
            assert_eq!(
                command_denial(command),
                Some("terminal-command-not-allowed"),
                "应当拒绝：{command}"
            );
        }
    }

    #[test]
    fn destructive_patterns_are_denied_even_under_an_allowed_executable() {
        // 白名单挡不住「git status && rm -rf /」这类组合，所以硬拒绝必须独立存在。
        for command in [
            "git status && rm -rf /",
            "npm run build | sh",
            "echo hi; format C:",
            "git push --force",
        ] {
            assert_eq!(
                command_denial(command),
                Some("terminal-command-denied"),
                "应当硬拒绝：{command}"
            );
        }
    }

    #[test]
    fn command_chaining_and_redirection_are_denied() {
        for command in [
            "npm test && npm run build",
            "cat a > b.txt",
            "ls $(whoami)",
            "echo `id`",
        ] {
            assert_eq!(
                command_denial(command),
                Some("terminal-command-chaining-denied"),
                "应当拒绝拼接：{command}"
            );
        }
    }

    #[test]
    fn paths_and_quotes_cannot_walk_around_the_allowlist() {
        assert_eq!(executable_name("C:\\Windows\\System32\\format"), None);
        assert_eq!(executable_name("/bin/rm -rf /"), None);
        assert_eq!(executable_name("\"npm\" test"), Some("npm".to_owned()));
        // 写成绝对路径的可执行文件不认：否则任意路径下的同名程序都能进白名单。
        assert_eq!(
            command_denial("/usr/bin/npm test"),
            Some("terminal-command-not-allowed")
        );
        assert_eq!(
            command_denial(".\\tools\\npm test"),
            Some("terminal-command-not-allowed")
        );
        // 又带路径又带破坏性片段时，硬拒绝优先于白名单判定。
        assert_eq!(
            command_denial("/bin/rm -rf /"),
            Some("terminal-command-denied")
        );
    }

    #[test]
    fn state_changing_but_legitimate_commands_still_need_confirmation() {
        assert!(!requires_confirmation("npm test"));
        assert!(requires_confirmation("git push origin main"));
        assert!(requires_confirmation("npm publish"));
        // 已被硬拒绝的命令不再走确认流程。
        assert_eq!(
            command_denial("git push --force"),
            Some("terminal-command-denied")
        );
    }

    #[test]
    fn validates_run_identifiers() {
        assert!(valid_run_id("run-123"));
        assert!(!valid_run_id("bad id"));
    }
}
