//! ZCode Adapter 进程侧（最小集成）：把 ZCode CLI 的 `agent-server` 协议子进程
//! 接进 NOVA 的原生层。
//!
//! 职责只有三件，协议语义全部留给 workbench 侧的 TS 适配层：
//! 1. spawn `<executable> agent-server`（argv 化，无 shell；固定追加协议子命令，
//!    前端不能注入任意参数——参数面越窄，攻击面越小）；
//! 2. 把子进程 stdout/stderr 逐行转发为 Tauri 事件（stdout 是 NDJSON 协议帧，
//!    stderr 是诊断日志，分开两个事件流）；
//! 3. 提供 stdin 写入（前端把协议请求帧写进来）与显式停止。
//!
//! 安全约束沿用终端的成熟做法：工作目录必须落在工作区内（SEC-011）、run_id
//! 原子预留 + 完成事件只发布一次（SEC-005）、写入帧禁止换行（防止 NDJSON 帧注入）。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{Mutex, Notify};

use crate::terminal::{resolve_executable, valid_run_id};
use crate::WorkspaceDirectoryState;

/// 单个 ZCode 协议子进程的共享句柄。
///
/// `Child` 的所有权归退出监控任务独占（见 start_zcode_agent 里的 select! 监控），
/// 共享状态只保留 stdin（写协议帧）、stop 信号（请求停止）与 exited 标志（存活判定）。
/// 这样任何命令都不需要跨 `wait().await` 持锁——旧实现的 child 锁会被监控长期持有，
/// 把写入与停止命令一起饿死。
struct ZCodeProcess {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stop: Arc<Notify>,
    exited: Arc<AtomicBool>,
}

/// 运行注册表：reserved（预留）/ runs（活跃）/ finished（完成去重）共用一把锁——
/// 「预留 → 登记」「退出 → 回收」都必须是原子状态迁移，否则并发启动会撕裂状态
/// （R1 审计 06：释放 reserved 与写入 runs 曾分属两把锁）。
#[derive(Default)]
struct ZCodeRegistry {
    runs: HashMap<String, ZCodeProcess>,
    reserved: HashSet<String>,
    finished: HashSet<String>,
}

/// finished 去重集上限：run_id 本就是一次性 UUID，超出后整集清空即可（退一次幂）。
const MAX_FINISHED_ENTRIES: usize = 4_096;

/// 单行 NDJSON 帧上限：与 valid_frame_line 的写入上限一致；超限视为协议违规。
const MAX_LINE_BYTES: usize = 1_048_576;

/// 运行状态：reserved/finished 语义与终端一致（SEC-005）。
pub struct ZCodeProcessState {
    registry: Arc<Mutex<ZCodeRegistry>>,
}

impl ZCodeProcessState {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(ZCodeRegistry::default())),
        }
    }
}

impl Default for ZCodeProcessState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartZCodeAgentRequest {
    pub run_id: String,
    /// ZCode CLI 可执行文件：PATH 上的命令名（如 `zcode`）或绝对路径。
    pub executable: String,
    /// 工作目录：ZCode 在这个目录上打开 workspace，必须落在 NOVA 工作区内。
    pub working_directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZCodeAgentStartResponse {
    pub run_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ZCodeLineEvent {
    run_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ZCodeExitEvent {
    run_id: String,
    code: Option<i32>,
}

/// 可执行文件路径只允许干净的路径字符：不允许 shell 元字符、空白控制符与引号。
/// argv 化 spawn 本来就不经过解释器，这里再收紧是为了防止路径里夹带意外语义。
fn valid_executable(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 512 {
        return false;
    }
    trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '\\' | '.' | '_' | '-' | ':' | ' '))
}

/// 与终端同一套工作目录约束（SEC-011）：显式指定必须 canonicalize 后在工作区内，
/// 缺省 = 工作区根。ZCode 在这个目录上打开 workspace，理应就是用户选中的项目。
fn working_directory(
    workspace: &State<WorkspaceDirectoryState>,
    requested: Option<&str>,
) -> Result<std::path::PathBuf, &'static str> {
    let root = crate::workspace_files::selected_root(workspace)?;
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            let candidate = std::path::PathBuf::from(value)
                .canonicalize()
                .map_err(|_| "zcode-workdir-invalid")?;
            if !candidate.starts_with(&root) {
                return Err("zcode-workdir-escapes-workspace");
            }
            Ok(candidate)
        }
        None => Ok(root),
    }
}

/// 协议请求帧只允许单行：换行会把一帧拆成两帧甚至注入伪造帧。
fn valid_frame_line(line: &str) -> bool {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    !trimmed.trim().is_empty() && trimmed.len() <= 1_048_576 && !trimmed.contains(['\n', '\r'])
}

#[tauri::command]
pub async fn start_zcode_agent(
    app: AppHandle,
    state: State<'_, ZCodeProcessState>,
    workspace: State<'_, WorkspaceDirectoryState>,
    request: StartZCodeAgentRequest,
) -> Result<ZCodeAgentStartResponse, &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("zcode-run-id-invalid");
    }
    let executable = request.executable.trim();
    if !valid_executable(executable) {
        return Err("zcode-executable-invalid");
    }
    let directory = working_directory(&workspace, request.working_directory.as_deref())?;
    // SEC-005：原子预留，spawn 失败释放（同一把锁内检查 + 占位）。
    {
        let mut registry = state.registry.lock().await;
        if registry.runs.contains_key(&request.run_id)
            || registry.reserved.contains(&request.run_id)
        {
            return Err("zcode-run-already-active");
        }
        registry.reserved.insert(request.run_id.clone());
    }
    // 固定追加 agent-server 子命令；可执行文件带路径分隔符时按路径直接用，
    // 否则走 PATH 解析（复用终端的解析逻辑，Windows 上含 .exe/.cmd 垫片处理）。
    let argv: Vec<String> = vec![executable.to_string(), "agent-server".to_string()];
    let command_head = std::path::Path::new(executable);
    let resolved = if command_head.components().count() > 1 {
        command_head.to_path_buf()
    } else {
        match resolve_executable(executable) {
            Some(path) => path,
            None => {
                state.registry.lock().await.reserved.remove(&request.run_id);
                return Err("zcode-executable-not-found");
            }
        }
    };
    let mut process = tokio::process::Command::new(&resolved);
    process
        .args(&argv[1..])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .current_dir(directory);
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(_) => {
            state.registry.lock().await.reserved.remove(&request.run_id);
            return Err("zcode-spawn-failed");
        }
    };
    let stdin = child
        .stdin
        .take()
        .ok_or("zcode-process-pipes-unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("zcode-process-pipes-unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("zcode-process-pipes-unavailable")?;
    let run_id = request.run_id.clone();
    let stop = Arc::new(Notify::new());
    let exited = Arc::new(AtomicBool::new(false));
    {
        // 预留 → 登记：同一把锁内原子迁移。
        let mut registry = state.registry.lock().await;
        registry.reserved.remove(&run_id);
        registry.runs.insert(
            run_id.clone(),
            ZCodeProcess {
                stdin: Arc::new(Mutex::new(Some(stdin))),
                stop: stop.clone(),
                exited: exited.clone(),
            },
        );
    }
    tauri::async_runtime::spawn(relay_lines(
        app.clone(),
        run_id.clone(),
        "stdout",
        stdout,
        stop.clone(),
    ));
    tauri::async_runtime::spawn(relay_lines(
        app.clone(),
        run_id.clone(),
        "stderr",
        stderr,
        stop.clone(),
    ));
    let registry = state.registry.clone();
    let exit_run_id = run_id.clone();
    // 退出监控独占 Child：select! 在「自然退出」与「stop 信号 → kill」之间裁决，
    // 全程不碰共享锁。退出后置 exited 标志、按 SEC-005 只发布一次完成事件。
    tauri::async_runtime::spawn(async move {
        let run_id = exit_run_id;
        let mut child = child;
        let code = tokio::select! {
            result = child.wait() => result.ok().and_then(|status| status.code()),
            _ = stop.notified() => {
                let _ = child.kill().await;
                child.wait().await.ok().and_then(|status| status.code())
            }
        };
        exited.store(true, Ordering::SeqCst);
        // 发布一次完成事件（SEC-005），并在同一把锁内回收活跃记录：退出后 runs
        // 不残留；finished 去重集有界（run_id 是一次性 UUID，整集清空退一次幂）。
        let should_emit = {
            let mut registry = registry.lock().await;
            let first = registry.finished.insert(run_id.clone());
            if registry.finished.len() > MAX_FINISHED_ENTRIES {
                registry.finished.clear();
                registry.finished.insert(run_id.clone());
            }
            registry.runs.remove(&run_id);
            first
        };
        if should_emit {
            let _ = app.emit(
                "zcode-protocol-exit",
                ZCodeExitEvent {
                    run_id: run_id.clone(),
                    code,
                },
            );
        }
    });
    Ok(ZCodeAgentStartResponse { run_id })
}

/// 逐行转发 stdout/stderr。读取按段扫描并强限单行字节数：超限视为协议违规，
/// 先请求停止异常子进程再终止转发，防止无界行耗尽内存（R1 审计 06）。
async fn relay_lines<R>(
    app: AppHandle,
    run_id: String,
    stream: &'static str,
    reader: R,
    stop: Arc<Notify>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    loop {
        let mut line: Vec<u8> = Vec::with_capacity(4096);
        let exceeded;
        let eof;
        loop {
            let available = match tokio::io::AsyncBufReadExt::fill_buf(&mut reader).await {
                Ok(available) => available,
                Err(_) => return,
            };
            if available.is_empty() {
                eof = true;
                exceeded = false;
                break;
            }
            match available.iter().position(|&byte| byte == b'\n') {
                Some(position) => {
                    line.extend_from_slice(&available[..position]);
                    reader.consume(position + 1);
                    eof = false;
                    exceeded = false;
                    break;
                }
                None => {
                    line.extend_from_slice(available);
                    let consumed = available.len();
                    reader.consume(consumed);
                    if line.len() > MAX_LINE_BYTES {
                        eof = false;
                        exceeded = true;
                        break;
                    }
                }
            }
        }
        if exceeded {
            let _ = app.emit(
                "zcode-protocol-line",
                ZCodeLineEvent {
                    run_id,
                    stream: "stderr",
                    text: "zcode-line-limit-exceeded".to_string(),
                },
            );
            stop.notify_one();
            return;
        }
        if eof && line.is_empty() {
            return;
        }
        let _ = app.emit(
            "zcode-protocol-line",
            ZCodeLineEvent {
                run_id: run_id.clone(),
                stream,
                text: String::from_utf8_lossy(&line)
                    .trim_end_matches(['\r', '\n'])
                    .to_string(),
            },
        );
        if eof {
            return;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZCodeWriteRequest {
    pub run_id: String,
    pub line: String,
}

/// 向协议子进程 stdin 写入一帧 NDJSON（不带换行的内容，这里补上 `\n`）。
#[tauri::command]
pub async fn zcode_write_stdin(
    state: State<'_, ZCodeProcessState>,
    request: ZCodeWriteRequest,
) -> Result<(), &'static str> {
    if !valid_frame_line(&request.line) {
        return Err("zcode-frame-invalid");
    }
    let process = state
        .registry
        .lock()
        .await
        .runs
        .get(&request.run_id)
        .map(|process| (process.stdin.clone(), process.exited.clone()))
        .ok_or("zcode-run-not-active")?;
    // stdin 已被关闭（半关语义）时按进程退出处理。
    let mut guard = process.0.lock().await;
    let Some(stdin) = guard.as_mut() else {
        return Err("zcode-run-not-active");
    };
    // 写入前确认进程还活着：退出监控已 reap 就不再接受写入。
    // 只读原子标志，不与监控任务抢任何锁。
    if process.1.load(Ordering::SeqCst) {
        let _ = guard.take();
        return Err("zcode-run-not-active");
    }
    stdin
        .write_all(format!("{}\n", request.line).as_bytes())
        .await
        .map_err(|_| "zcode-stdin-write-failed")?;
    stdin.flush().await.map_err(|_| "zcode-stdin-write-failed")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopZCodeAgentRequest {
    pub run_id: String,
}

/// 停止协议子进程：先关 stdin（给 agent-server 一个优雅退出机会），再发停止信号。
/// kill 与 reap 由退出监控任务执行（它独占 Child），这里只负责信号，永不阻塞。
#[tauri::command]
pub async fn stop_zcode_agent(
    state: State<'_, ZCodeProcessState>,
    request: StopZCodeAgentRequest,
) -> Result<(), &'static str> {
    let process = state
        .registry
        .lock()
        .await
        .runs
        .get(&request.run_id)
        .map(|process| (process.stdin.clone(), process.stop.clone()))
        .ok_or("zcode-run-not-active")?;
    process.0.lock().await.take();
    process.1.notify_one();
    Ok(())
}

/// 返回当前工作区根的绝对路径，仅供 ZCode Agent 会话使用（session/create 的
/// workspace.workspacePath 与 start_zcode_agent 的工作目录同源）。
///
/// 与「选择工作区时 WebView 只收 label」的一般隐私立场不同：协议握手必须有真实
/// 路径，而这个路径本来就会通过 start_zcode_agent 的工作目录约束回到本进程。
/// 该路径只在本机内存中流转，不落盘、不上传、不进诊断日志；未选择工作区时报错。
#[tauri::command]
pub fn zcode_workspace_root(
    workspace: State<'_, WorkspaceDirectoryState>,
) -> Result<String, &'static str> {
    let root = crate::workspace_files::selected_root(&workspace)?;
    root.to_str()
        .map(str::to_owned)
        .ok_or("workspace-root-unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executables_are_restricted() {
        assert!(valid_executable("zcode"));
        assert!(valid_executable("D:/tools/zcode-cli/zcode.exe"));
        assert!(valid_executable("C:\\tools\\zcode\\zcode.cmd"));
        assert!(!valid_executable(""));
        assert!(!valid_executable("zcode; rm -rf /"));
        assert!(!valid_executable("zcode | echo"));
        assert!(!valid_executable("zcode\nagent-server"));
        assert!(!valid_executable(&"a".repeat(513)));
    }

    #[test]
    fn frames_must_be_single_lines_within_budget() {
        assert!(valid_frame_line("{\"id\":1,\"method\":\"session/create\"}"));
        assert!(!valid_frame_line(""));
        assert!(!valid_frame_line("   "));
        assert!(!valid_frame_line("frame\ninjected"));
        assert!(!valid_frame_line("frame\r\ninjected"));
        assert!(!valid_frame_line(&"x".repeat(1_048_577)));
    }
}
