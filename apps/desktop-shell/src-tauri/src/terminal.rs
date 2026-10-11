use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{sleep, Duration},
};

use crate::WorkspaceDirectoryState;

type SharedChild = Arc<Mutex<Child>>;
/// 正在运行的子进程。只有真正 spawn 成功后才会出现在这里。
type RunMap = Arc<Mutex<HashMap<String, SharedChild>>>;
/// 已发出过完成事件的 run_id：保证一个 run 恰好一个 done 事件。
type FinishedSet = Arc<Mutex<HashSet<String>>>;

/// 终端运行状态。
///
/// SEC-005：启动要「先原子预留 ID，再 spawn，再放进运行表」，三步不原子时
/// 两个并发请求可能用同一个 ID 各起一个进程。取消与自然退出共用一个
/// 「完成集合」去重，保证完成事件只发布一次。
pub struct TerminalRunState {
    runs: RunMap,
    reserved: FinishedSet,
    finished: FinishedSet,
}

impl TerminalRunState {
    pub fn new() -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::new())),
            reserved: Arc::new(Mutex::new(HashSet::new())),
            finished: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

impl Default for TerminalRunState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminalCommandRequest {
    pub run_id: String,
    pub command: String,
    pub confirm_dangerous: bool,
    /// 可选：显式指定工作目录。SEC-011：缺省时落到用户选中的工作区根，
    /// 让「在终端里跑构建」默认发生在用户正在看的项目里。
    pub working_directory: Option<String>,
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

pub(crate) fn valid_run_id(value: &str) -> bool {
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

/// 不允许命令拼接、管道与重定向。一条命令就是一条命令：
/// `npm test && rm -rf x` 这类组合会让白名单完全失效。
///
/// SEC-001：这条列表同时是「直接 argv 执行」的前提——只有当命令里
/// 不存在任何 shell 语法时，把它拆成 argv 直接 spawn 才是等价且更严的。
/// 管道与输入重定向没有 shell 就毫无意义，一并禁止，杜绝歧义。
const FORBIDDEN_OPERATORS: &[&str] = &[
    "&&", "||", ";", "\n", "\r", "`", "$(", ">", "|", "<", "&", ">>",
];

/// 把命令行拆成 argv：尊重双引号包裹的参数，拒绝未闭合引号。
///
/// 既然管道、拼接、命令替换都已在 FORBIDDEN_OPERATORS 里被拒绝，
/// 这里唯一的解释自由度就是引号；拆出来的每个参数都会原样传给子进程，
/// 不再经过任何 shell 的二次解释。
fn split_argv(command: &str) -> Option<Vec<String>> {
    let mut argv: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for character in command.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            ' ' | '\t' if !in_quotes => {
                if has_token {
                    argv.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            other => {
                current.push(other);
                has_token = true;
            }
        }
    }
    if in_quotes {
        return None;
    }
    if has_token {
        argv.push(current);
    }
    (!argv.is_empty()).then_some(argv)
}

/// 取出 argv 首项作为可执行文件名。带路径的一律不认，
/// 否则 `C:\Windows\System32\format` 之类能绕过白名单。
fn executable_name(argv: &[String]) -> Option<String> {
    let first = argv.first()?;
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
    let Some(argv) = split_argv(command) else {
        return Some("terminal-command-invalid");
    };
    match executable_name(&argv) {
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

/// 在 PATH 里解析白名单可执行文件的真实位置。
///
/// SEC-001：命令不再经过 `cmd /C` / `sh -lc`，必须自己找到可执行文件。
/// Windows 上 npm/pnpm/npx/yarn 是 `.cmd` 垫片，CreateProcess 找不到它们，
/// 所以这里把 `.exe` 与 `.cmd`/`.bat` 都搜出来；`.cmd`/`.bat` 由 Rust 标准库
/// 按 BatBadBut 修复后的方式经 cmd.exe 逐参数转义执行，参数不再整串进 shell。
pub(crate) fn resolve_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    std::env::split_paths(&path).find_map(|directory| {
        candidates.iter().find_map(|extension| {
            let candidate = if extension.is_empty() {
                directory.join(name)
            } else {
                directory.join(format!("{name}.{extension}"))
            };
            let is_file = std::fs::metadata(&candidate)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);
            is_file.then_some(candidate)
        })
    })
}

/// argv 化执行：可执行文件 + 逐个参数，没有任何 shell 插值。
fn command_for(resolved: &PathBuf, argv: &[String]) -> Command {
    let mut process = Command::new(resolved);
    process.args(&argv[1..]);
    process
}

/// 计算子进程的工作目录：显式指定则必须落在选中工作区内，否则默认工作区根。
fn working_directory(
    workspace: &State<'_, WorkspaceDirectoryState>,
    requested: Option<&str>,
) -> Result<Option<PathBuf>, &'static str> {
    let root = workspace
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .clone();
    let Some(root) = root else {
        // 未选工作区：没有可锚定的目录，保持与旧版一致（继承应用目录）。
        return Ok(None);
    };
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            let candidate = std::path::PathBuf::from(value)
                .canonicalize()
                .map_err(|_| "terminal-workdir-invalid")?;
            if !candidate.starts_with(&root) {
                return Err("terminal-workdir-escapes-workspace");
            }
            Ok(Some(candidate))
        }
        None => Ok(Some(root)),
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

/// 发布完成事件；同一 run_id 只会发布一次。取消路径与自然退出路径都走这里，
/// SEC-005 的「完成事件一致性」由这个集合保证，而不是靠各方自觉。
async fn publish_done(
    finished: &FinishedSet,
    app: &AppHandle,
    run_id: &str,
    event: TerminalDoneEvent,
) -> bool {
    let mut finished = finished.lock().await;
    if !finished.insert(run_id.to_owned()) {
        return false;
    }
    drop(finished);
    let _ = app.emit("terminal-command-done", event);
    true
}

#[tauri::command]
pub async fn start_terminal_command(
    app: AppHandle,
    state: State<'_, TerminalRunState>,
    workspace: State<'_, WorkspaceDirectoryState>,
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
    let directory = working_directory(&workspace, request.working_directory.as_deref())?;
    // SEC-005：先原子预留 run_id，spawn 失败时释放；并发请求在这里就撞墙。
    {
        let (runs, reserved) = (&state.runs, &state.reserved);
        let runs = runs.lock().await;
        let mut reserved = reserved.lock().await;
        if runs.contains_key(&request.run_id) || reserved.contains(&request.run_id) {
            return Err("terminal-run-already-active");
        }
        reserved.insert(request.run_id.clone());
    }
    let Some(argv) = split_argv(command) else {
        state.reserved.lock().await.remove(&request.run_id);
        return Err("terminal-command-invalid");
    };
    let Some(resolved) = resolve_executable(executable_name(&argv).unwrap_or_default().as_str())
    else {
        state.reserved.lock().await.remove(&request.run_id);
        return Err("terminal-command-not-found");
    };
    let mut process = command_for(&resolved, &argv);
    process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(directory) = directory {
        process.current_dir(directory);
    }
    let spawn_result = process.spawn();
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(_) => {
            state.reserved.lock().await.remove(&request.run_id);
            return Err("terminal-command-spawn-failed");
        }
    };
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
    state.reserved.lock().await.remove(&run_id);
    state.runs.lock().await.insert(run_id.clone(), child.clone());
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stdout", stdout));
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stderr", stderr));
    let runs = state.runs.clone();
    let finished = state.finished.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = {
                let mut process = child.lock().await;
                process.try_wait()
            };
            match status {
                Ok(Some(status)) => {
                    runs.lock().await.remove(&run_id);
                    publish_done(
                        &finished,
                        &app,
                        &run_id,
                        TerminalDoneEvent {
                            run_id: run_id.clone(),
                            exit_code: status.code(),
                            cancelled: false,
                            error: None,
                        },
                    )
                    .await;
                    return;
                }
                Ok(None) => sleep(Duration::from_millis(120)).await,
                Err(_) => {
                    runs.lock().await.remove(&run_id);
                    publish_done(
                        &finished,
                        &app,
                        &run_id,
                        TerminalDoneEvent {
                            run_id: run_id.clone(),
                            exit_code: None,
                            cancelled: false,
                            error: Some("terminal-command-status-failed".to_owned()),
                        },
                    )
                    .await;
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
        .runs
        .lock()
        .await
        .get(&request.run_id)
        .cloned()
        .ok_or("terminal-run-not-found")?;
    child
        .lock()
        .await
        .start_kill()
        .map_err(|_| "terminal-command-cancel-failed")?;
    // 完成事件只发一次：这里的 cancelled done 先占住「完成集合」，
    // 监视循环随后看到的真实退出码会被去重掉。
    publish_done(
        &state.finished,
        &app,
        &request.run_id,
        TerminalDoneEvent {
            run_id: request.run_id.clone(),
            exit_code: None,
            cancelled: true,
            error: None,
        },
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{command_denial, executable_name, requires_confirmation, split_argv, valid_run_id};

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
            // SEC-001：没有 shell 之后管道与输入重定向同样没有意义，一并拒绝。
            "npm test | head",
            "cat < secret.txt",
        ] {
            assert_eq!(
                command_denial(command),
                Some("terminal-command-chaining-denied"),
                "应当拒绝拼接：{command}"
            );
        }
    }

    #[test]
    fn split_argv_respects_quotes_and_rejects_unterminated() {
        assert_eq!(
            split_argv("npm test \"a b\" c"),
            Some(vec![
                "npm".to_owned(),
                "test".to_owned(),
                "a b".to_owned(),
                "c".to_owned()
            ])
        );
        assert_eq!(split_argv("git commit -m \"fix: two words\"").as_deref().map(|argv| argv.len()), Some(4));
        assert_eq!(split_argv("git commit -m \"unterminated"), None);
        assert_eq!(split_argv("   "), None);
    }

    #[test]
    fn paths_and_quotes_cannot_walk_around_the_allowlist() {
        assert_eq!(executable_name(&split_argv("C:\\Windows\\System32\\format").expect("argv")), None);
        assert_eq!(executable_name(&split_argv("/bin/rm -rf /").expect("argv")), None);
        assert_eq!(
            executable_name(&split_argv("\"npm\" test").expect("argv")),
            Some("npm".to_owned())
        );
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
