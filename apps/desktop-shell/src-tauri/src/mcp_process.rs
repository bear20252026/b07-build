//! MCP stdio 进程侧：把已注册 MCP 服务器的连接规格变成受监督的子进程。
//!
//! 职责与 ZCode Adapter 进程侧同构，但参数面更一般（MCP 服务器不是固定
//! `agent-server` 子命令，executable + args 来自注册表的 connection 声明）：
//! 1. spawn `executable args...`（argv 化，无 shell；规格与帧纪律全部委托
//!    process-supervisor 的 mcp_stdio 纯逻辑校验）；
//! 2. stdout/stderr 逐行转发为 Tauri 事件（stdout 是 MCP NDJSON 协议帧，
//!    stderr 是诊断日志，两个事件流分开；单行 1MB 上限，超限即停）；
//! 3. stdin 帧写入（前端把 JSON-RPC 帧写进来）与显式停止（先半关 stdin
//!    给优雅退出宽限，再杀进程树——不允许留下孤儿）。
//!
//! 安全约束沿用 zcode_process 的成熟做法：工作目录必须落在工作区内、
//! run_id 原子预留 + 完成事件只发布一次、写入帧禁止换行（帧注入防护）。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{Mutex, Notify};

use process_supervisor::mcp_stdio::{normalize_frame, McpStdioSpec, MAX_LINE_BYTES};

use crate::terminal::{resolve_executable, valid_run_id};
use crate::WorkspaceDirectoryState;

/// 单个 MCP stdio 子进程的共享句柄：stdin（写协议帧）+ stop 信号 + exited 标志。
/// Child 所有权归退出监控任务独占（与 zcode_process 同款锁纪律，避免写命令被饿死）。
struct McpStdioProcess {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stop: Arc<Notify>,
    exited: Arc<AtomicBool>,
}

/// 运行注册表：reserved / runs / finished 共用一把锁——「预留 → 登记」「退出 → 回收」
/// 必须是原子状态迁移（R1 审计 06 的教训）。
#[derive(Default)]
struct McpStdioRegistry {
    runs: HashMap<String, McpStdioProcess>,
    reserved: HashSet<String>,
    finished: HashSet<String>,
}

/// finished 去重集上限：run_id 本就是一次性 UUID，超出后整集清空（退一次幂）。
const MAX_FINISHED_ENTRIES: usize = 4_096;

pub struct McpStdioState {
    registry: Arc<Mutex<McpStdioRegistry>>,
}

impl McpStdioState {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(McpStdioRegistry::default())),
        }
    }
}

impl Default for McpStdioState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMcpStdioRequest {
    pub run_id: String,
    /// MCP 服务器可执行文件：PATH 命令名或绝对路径（禁止 shell 元字符）。
    pub executable: String,
    /// argv：直接追加（如 `["--transport", "stdio"]`），每条 ≤1024 字符、无控制符。
    #[serde(default)]
    pub args: Vec<String>,
    /// 显式注入的环境变量（代理/CA 等）；键限 [A-Za-z0-9_]，值禁 NUL。
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// 工作目录：必须落在 NOVA 工作区内；缺省 = 工作区根。
    pub working_directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioStartResponse {
    pub run_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStdioLineEvent {
    run_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStdioExitEvent {
    run_id: String,
    code: Option<i32>,
}

/// 可执行文件路径只允许干净字符（与 zcode_process 同款收紧）。
fn valid_executable(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 512 {
        return false;
    }
    trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '\\' | '.' | '_' | '-' | ':' | ' '))
}

/// 与终端同一套工作目录约束：显式指定必须 canonicalize 后在工作区内。
fn working_directory(
    workspace: &State<WorkspaceDirectoryState>,
    requested: Option<&str>,
) -> Result<std::path::PathBuf, &'static str> {
    let root = crate::workspace_files::selected_root(workspace)?;
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            let candidate = std::path::PathBuf::from(value)
                .canonicalize()
                .map_err(|_| "mcp-workdir-invalid")?;
            if !candidate.starts_with(&root) {
                return Err("mcp-workdir-escapes-workspace");
            }
            Ok(candidate)
        }
        None => Ok(root),
    }
}

/// 把启动请求收敛成 crate 校验过的规格：executable 解析 + args/env 纪律都在
/// spec.validate() 内完成——命令层不重复实现安全规则。
fn build_spec(request: &StartMcpStdioRequest) -> Result<McpStdioSpec, &'static str> {
    let executable = request.executable.trim();
    let command_head = std::path::Path::new(executable);
    let resolved = if command_head.components().count() > 1 {
        command_head.to_path_buf()
    } else {
        resolve_executable(executable).ok_or("mcp-executable-not-found")?
    };
    let spec = McpStdioSpec {
        run_id: request.run_id.clone(),
        executable: resolved,
        args: request.args.clone(),
        env: request.env.clone(),
        max_line_bytes: MAX_LINE_BYTES,
    };
    spec.validate().map_err(|error| {
        // 规格错误统一映射为稳定错误码；细节只进本机日志，不回给前端。
        eprintln!("[mcp-stdio] spec rejected: {error}");
        "mcp-spec-invalid"
    })?;
    Ok(spec)
}

#[tauri::command]
pub async fn mcp_start_process(
    app: AppHandle,
    state: State<'_, McpStdioState>,
    workspace: State<'_, WorkspaceDirectoryState>,
    request: StartMcpStdioRequest,
) -> Result<McpStdioStartResponse, &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("mcp-run-id-invalid");
    }
    if !valid_executable(&request.executable) {
        return Err("mcp-executable-invalid");
    }
    let directory = working_directory(&workspace, request.working_directory.as_deref())?;
    let spec = build_spec(&request)?;
    // SEC-005：原子预留，spawn 失败释放。
    {
        let mut registry = state.registry.lock().await;
        if registry.runs.contains_key(&request.run_id)
            || registry.reserved.contains(&request.run_id)
        {
            return Err("mcp-run-already-active");
        }
        registry.reserved.insert(request.run_id.clone());
    }
    let mut process = tokio::process::Command::new(&spec.executable);
    process
        .args(&spec.args)
        .envs(spec.env.iter().cloned())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .current_dir(directory);
    #[cfg(target_os = "windows")]
    {
        // tokio::process::Command 在 Windows 上原生暴露 creation_flags（无需 std trait）。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(_) => {
            state.registry.lock().await.reserved.remove(&request.run_id);
            return Err("mcp-spawn-failed");
        }
    };
    let stdin = child.stdin.take().ok_or("mcp-process-pipes-unavailable")?;
    let stdout = child.stdout.take().ok_or("mcp-process-pipes-unavailable")?;
    let stderr = child.stderr.take().ok_or("mcp-process-pipes-unavailable")?;
    let run_id = request.run_id.clone();
    let stop = Arc::new(Notify::new());
    let exited = Arc::new(AtomicBool::new(false));
    // 每次启动生成唯一实例 id：完成事件去重按实例（SEC-005）。
    use rand::RngCore;
    let mut instance_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut instance_bytes);
    let instance_id = format!(
        "{}-{}",
        run_id,
        instance_bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    {
        // 预留 → 登记：同一把锁内原子迁移。
        let mut registry = state.registry.lock().await;
        registry.reserved.remove(&run_id);
        registry.runs.insert(
            run_id.clone(),
            McpStdioProcess {
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
        spec.max_line_bytes,
    ));
    tauri::async_runtime::spawn(relay_lines(
        app.clone(),
        run_id.clone(),
        "stderr",
        stderr,
        stop.clone(),
        spec.max_line_bytes,
    ));
    let registry = state.registry.clone();
    let exit_run_id = run_id.clone();
    let response = McpStdioStartResponse {
        run_id: run_id.clone(),
    };
    // 退出监控独占 Child：select! 在「自然退出」与「stop 信号 → 杀进程树」之间裁决。
    tauri::async_runtime::spawn(async move {
        let mut child = child;
        let code = tokio::select! {
            result = child.wait() => result.ok().and_then(|status| status.code()),
            _ = stop.notified() => {
                // 宽限由半关 stdin 在 stop 命令里完成；这里直接杀进程树（taskkill /F /T）。
                let _ = child.kill().await;
                child.wait().await.ok().and_then(|status| status.code())
            }
        };
        exited.store(true, Ordering::SeqCst);
        let should_emit = {
            let mut registry = registry.lock().await;
            let first = registry.finished.insert(instance_id.clone());
            if registry.finished.len() > MAX_FINISHED_ENTRIES {
                registry.finished.clear();
                registry.finished.insert(instance_id);
            }
            registry.runs.remove(&run_id);
            first
        };
        if should_emit {
            let _ = app.emit(
                "mcp-process-exit",
                McpStdioExitEvent {
                    run_id: exit_run_id,
                    code,
                },
            );
        }
    });
    Ok(response)
}

/// 逐行转发 stdout/stderr。读取按段扫描并强限单行字节数：超限视为协议违规，
/// 先请求停止异常子进程再终止转发（与 zcode_process 的 relay 同款有界实现）。
async fn relay_lines<R>(
    app: AppHandle,
    run_id: String,
    stream: &'static str,
    reader: R,
    stop: Arc<Notify>,
    max_line_bytes: usize,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    loop {
        let mut line: Vec<u8> = Vec::with_capacity(4096);
        let exceeded;
        let eof;
        loop {
            let available = match AsyncBufReadExt::fill_buf(&mut reader).await {
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
                    if line.len() + position > max_line_bytes {
                        eof = false;
                        exceeded = true;
                        break;
                    }
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
                    if line.len() > max_line_bytes {
                        eof = false;
                        exceeded = true;
                        break;
                    }
                }
            }
        }
        if exceeded {
            let _ = app.emit(
                "mcp-process-line",
                McpStdioLineEvent {
                    run_id,
                    stream: "stderr",
                    text: "mcp-line-limit-exceeded".to_string(),
                },
            );
            stop.notify_one();
            return;
        }
        if eof && line.is_empty() {
            return;
        }
        let _ = app.emit(
            "mcp-process-line",
            McpStdioLineEvent {
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
pub struct McpStdioWriteRequest {
    pub run_id: String,
    pub line: String,
}

/// 向 MCP 服务器 stdin 写入一帧 STDIO 协议帧（单行；这里补 `\n`）。
#[tauri::command]
pub async fn mcp_write_stdin(
    state: State<'_, McpStdioState>,
    request: McpStdioWriteRequest,
) -> Result<(), &'static str> {
    // 帧纪律委托 crate：单行 + 1MB 上限，换行帧（帧注入）在此拒绝。
    normalize_frame(&request.line, MAX_LINE_BYTES).map_err(|_| "mcp-frame-invalid")?;
    let process = state
        .registry
        .lock()
        .await
        .runs
        .get(&request.run_id)
        .map(|process| (process.stdin.clone(), process.exited.clone()))
        .ok_or("mcp-run-not-active")?;
    let mut guard = process.0.lock().await;
    let Some(stdin) = guard.as_mut() else {
        return Err("mcp-run-not-active");
    };
    if process.1.load(Ordering::SeqCst) {
        let _ = guard.take();
        return Err("mcp-run-not-active");
    }
    stdin
        .write_all(format!("{}\n", request.line).as_bytes())
        .await
        .map_err(|_| "mcp-stdin-write-failed")?;
    stdin.flush().await.map_err(|_| "mcp-stdin-write-failed")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMcpStdioRequest {
    pub run_id: String,
}

/// 停止 MCP 服务器：先半关 stdin（优雅退出宽限），再通知退出监控杀进程树。
/// kill 与 reap 由退出监控任务执行，这里只发信号，永不阻塞。
#[tauri::command]
pub async fn mcp_stop_process(
    state: State<'_, McpStdioState>,
    request: StopMcpStdioRequest,
) -> Result<(), &'static str> {
    let process = state
        .registry
        .lock()
        .await
        .runs
        .get(&request.run_id)
        .map(|process| (process.stdin.clone(), process.stop.clone()))
        .ok_or("mcp-run-not-active")?;
    process.0.lock().await.take();
    process.1.notify_one();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executables_are_restricted() {
        assert!(valid_executable("mcp-server"));
        assert!(valid_executable("D:/tools/mcp/server.exe"));
        assert!(valid_executable("C:\\tools\\mcp\\server.cmd"));
        assert!(!valid_executable(""));
        assert!(!valid_executable("mcp; rm -rf /"));
        assert!(!valid_executable("mcp | echo"));
        assert!(!valid_executable(&"a".repeat(513)));
    }

    #[test]
    fn spec_validation_rejects_bad_args_and_env() {
        let base = || StartMcpStdioRequest {
            run_id: "mcp-demo-1".to_string(),
            // 跨平台绝对路径夹具（is_absolute 语义随平台变化；current_dir 的字符
            // 都落在 valid_executable 白名单内，而 CI 的临时目录可能含 ~）。
            executable: std::env::current_dir()
                .expect("cwd")
                .join("awo-test-mcp-server")
                .to_string_lossy()
                .to_string(),
            args: vec!["--transport".to_string(), "stdio".to_string()],
            env: vec![],
            working_directory: None,
        };
        // 绝对路径 + 合法 args/env：规格通过（存在性由 spawn 负责，不是校验职责）。
        let spec = build_spec(&base()).expect("valid spec should build");
        assert_eq!(spec.run_id, "mcp-demo-1");
        assert_eq!(spec.args, vec!["--transport", "stdio"]);
        assert_eq!(spec.max_line_bytes, MAX_LINE_BYTES);
        // PATH 命令名且解析不到 → 稳定错误码。
        let mut unknown = base();
        unknown.executable = "definitely-not-on-path-mcp".to_string();
        assert!(matches!(
            build_spec(&unknown),
            Err("mcp-executable-not-found")
        ));
        // 控制符 arg：crate 校验拒绝（build_spec 映射为 mcp-spec-invalid）。
        let mut bad_args = base();
        bad_args.args = vec!["--flag\ninjected".to_string()];
        assert!(matches!(build_spec(&bad_args), Err("mcp-spec-invalid")));
        // 非法 env key：同上。
        let mut bad_env = base();
        bad_env.env = vec![("BAD KEY".to_string(), "v".to_string())];
        assert!(matches!(build_spec(&bad_env), Err("mcp-spec-invalid")));
        // run_id 非法：命令层第一道闸（crate 校验之前）。
        let mut bad_run = base();
        bad_run.run_id = "run id".to_string();
        assert!(!valid_run_id(&bad_run.run_id));
    }

    #[test]
    fn frames_must_be_single_lines_within_budget() {
        assert_eq!(
            normalize_frame("{\"jsonrpc\":\"2.0\",\"id\":1}\n", MAX_LINE_BYTES).unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":1}"
        );
        assert!(normalize_frame("", MAX_LINE_BYTES).is_err());
        assert!(normalize_frame("frame\ninjected", MAX_LINE_BYTES).is_err());
        assert!(normalize_frame(&"x".repeat(MAX_LINE_BYTES + 1), MAX_LINE_BYTES).is_err());
    }
}
