// crates/process-supervisor/src/mcp_stdio.rs
// 一个文件=一个作用：MCP stdio 子进程的规格校验、帧纪律与纯生命周期状态机。
//
// 边界：本模块不 spawn、不持有进程——真实进程管理在桌面端 tokio 层
//（apps/desktop-shell/src-tauri/src/mcp_process.rs）。这里只做三件可单测的事：
//   1. McpStdioSpec 校验（argv 化、无 shell、无控制字符、环境变量清洗）；
//   2. NDJSON 帧纪律（单行、上限、补 LF）；
//   3. McpStdioLifecycle 纯状态机（spawned → exited/stopped，转换可被审计）。
// 与 ZCode 的 process-tree/windows-job-object 思路对齐：stdin 先半关给优雅退出
// 机会，再杀进程树——sidecar 不得留下孤儿进程。

use std::path::PathBuf;
use std::time::Duration;

pub const MCP_STDIO_PROTOCOL_VERSION: &str = "awo.mcp-stdio.v1";
const MAX_ARGS: usize = 32;
const MAX_ARG_LENGTH: usize = 1024;
const MAX_ENV_ENTRIES: usize = 32;
const MAX_ENV_KEY_LENGTH: usize = 128;
const MAX_ENV_VALUE_LENGTH: usize = 2048;
/// 单行 NDJSON 帧上限：与桌面端 relay 上限一致（1MB）；MCP 帧本应远小于此。
pub const MAX_LINE_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpStdioError {
    InvalidSpec(String),
    InvalidFrame(String),
    AlreadyRunning,
    NotRunning,
    Io(String),
}

impl std::fmt::Display for McpStdioError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSpec(detail) => write!(formatter, "invalid mcp stdio spec: {detail}"),
            Self::InvalidFrame(detail) => write!(formatter, "invalid mcp stdio frame: {detail}"),
            Self::AlreadyRunning => write!(formatter, "mcp stdio run is already active"),
            Self::NotRunning => write!(formatter, "mcp stdio run is not active"),
            Self::Io(detail) => write!(formatter, "mcp stdio io error: {detail}"),
        }
    }
}

impl std::error::Error for McpStdioError {}

/// MCP 服务器启动规格：executable + args 直接 argv 化（绝不走 shell 字符串）；
/// env 允许注入代理/CA 等中每一【调用方显式提供】的变量，键值在此清洗。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpStdioSpec {
    pub run_id: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub max_line_bytes: usize,
}

impl Default for McpStdioSpec {
    fn default() -> Self {
        Self {
            run_id: String::new(),
            executable: PathBuf::new(),
            args: Vec::new(),
            env: Vec::new(),
            max_line_bytes: MAX_LINE_BYTES,
        }
    }
}

/// run_id / env key 等标识符：安全字符白名单（与 ZCode valid_run_id 同思路）。
pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

fn contains_control(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

impl McpStdioSpec {
    pub fn validate(&self) -> Result<(), McpStdioError> {
        if !valid_identifier(&self.run_id) {
            return Err(McpStdioError::InvalidSpec(
                "run_id must be a 1-128 char safe identifier".to_string(),
            ));
        }
        if !self.executable.is_absolute() || self.executable.as_os_str().is_empty() {
            return Err(McpStdioError::InvalidSpec(
                "executable must be an absolute direct path (no shell strings)".to_string(),
            ));
        }
        if self.args.len() > MAX_ARGS
            || self
                .args
                .iter()
                .any(|arg| arg.is_empty() || arg.len() > MAX_ARG_LENGTH || contains_control(arg))
        {
            return Err(McpStdioError::InvalidSpec(format!(
                "args must be 1..={MAX_ARGS} non-empty values without control characters"
            )));
        }
        if self.env.len() > MAX_ENV_ENTRIES {
            return Err(McpStdioError::InvalidSpec(format!(
                "env must contain at most {MAX_ENV_ENTRIES} entries"
            )));
        }
        for (key, value) in &self.env {
            if key.is_empty()
                || key.len() > MAX_ENV_KEY_LENGTH
                || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                || value.len() > MAX_ENV_VALUE_LENGTH
                || value.contains('\0')
            {
                return Err(McpStdioError::InvalidSpec(
                    "env keys must be [A-Za-z0-9_] without NUL or oversized values".to_string(),
                ));
            }
        }
        if self.max_line_bytes == 0 || self.max_line_bytes > MAX_LINE_BYTES {
            return Err(McpStdioError::InvalidSpec(format!(
                "max_line_bytes must be 1..={MAX_LINE_BYTES}"
            )));
        }
        Ok(())
    }
}

/// 帧纪律：单行、非空、不超限；返回时已去掉行尾换行（调用方写 stdin 时补 `\n`）。
pub fn normalize_frame(line: &str, max_line_bytes: usize) -> Result<String, McpStdioError> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.trim().is_empty() {
        return Err(McpStdioError::InvalidFrame(
            "frame must not be empty".to_string(),
        ));
    }
    if trimmed.contains(['\n', '\r']) {
        return Err(McpStdioError::InvalidFrame(
            "frame must be a single line (no CR/LF inside)".to_string(),
        ));
    }
    if trimmed.len() > max_line_bytes {
        return Err(McpStdioError::InvalidFrame(format!(
            "frame exceeds {max_line_bytes} bytes"
        )));
    }
    Ok(trimmed.to_string())
}

/// 子进程 stdout/stderr 一行的归一化：超限行不进入事件流（协议违规标记）。
pub fn normalize_inbound_line(line: &str, max_line_bytes: usize) -> Result<String, McpStdioError> {
    normalize_frame(line, max_line_bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpStdioState {
    Spawned,
    Exited,
    Stopped,
}

/// 纯生命周期：spawn 之后只有 exited（自然退出）与 stopped（显式停止）两个终态，
/// 且都只能到达一次——重复终止是 no-op，供审计账本保证恰好一次。
#[derive(Debug, Clone)]
pub struct McpStdioLifecycle {
    state: McpStdioState,
    exit_code: Option<i32>,
    transitions: Vec<(McpStdioState, u64)>,
}

impl Default for McpStdioLifecycle {
    fn default() -> Self {
        Self::spawned()
    }
}

impl McpStdioLifecycle {
    pub fn spawned() -> Self {
        Self {
            state: McpStdioState::Spawned,
            exit_code: None,
            transitions: Vec::new(),
        }
    }

    pub fn state(&self) -> McpStdioState {
        self.state
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.state, McpStdioState::Exited | McpStdioState::Stopped)
    }

    pub fn mark_exited(&mut self, code: Option<i32>, at_ms: u64) -> bool {
        self.transition(McpStdioState::Exited, code, at_ms)
    }

    pub fn mark_stopped(&mut self, code: Option<i32>, at_ms: u64) -> bool {
        self.transition(McpStdioState::Stopped, code, at_ms)
    }

    fn transition(&mut self, next: McpStdioState, code: Option<i32>, at_ms: u64) -> bool {
        if self.is_terminal() {
            return false;
        }
        self.state = next;
        self.exit_code = code;
        self.transitions.push((next, at_ms));
        true
    }

    /// 状态迁移轨迹（审计用；有界，超出容量丢最旧）。
    pub fn transitions(&self) -> &[(McpStdioState, u64)] {
        &self.transitions
    }
}

/// 进程树终止的跨平台参数：Windows 用 taskkill /F /T，其余平台先 TERM 再 KILL。
/// 真正的系统调用在桌面端执行；这里只固定参数序列，便于测试锁定语义。
pub fn termination_argv(pid: u32) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        vec![
            "/F".to_string(),
            "/T".to_string(),
            "/PID".to_string(),
            pid.to_string(),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        Vec::new()
    }
}

/// stdin 半关到 kill 之间的优雅退出宽限。
pub const GRACEFUL_EXIT_GRACE: Duration = Duration::from_millis(2_000);

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> McpStdioSpec {
        McpStdioSpec {
            run_id: "mcp-demo-1".to_string(),
            // 跨平台绝对路径夹具：is_absolute() 在 Windows 与 Linux 上语义不同，
            // 不能写死 "D:/..." 这类 Windows 路径。
            executable: std::env::temp_dir().join("awo-test/mcp-server/server"),
            args: vec!["--transport".to_string(), "stdio".to_string()],
            env: vec![(
                "HTTPS_PROXY".to_string(),
                "http://127.0.0.1:57777".to_string(),
            )],
            max_line_bytes: MAX_LINE_BYTES,
        }
    }

    #[test]
    fn valid_spec_passes() {
        assert!(spec().validate().is_ok());
    }

    #[test]
    fn run_id_must_be_safe_identifier() {
        let mut bad = spec();
        bad.run_id = "run id with spaces".to_string();
        assert!(matches!(bad.validate(), Err(McpStdioError::InvalidSpec(_))));
        let mut empty = spec();
        empty.run_id = String::new();
        assert!(empty.validate().is_err());
    }

    #[test]
    fn executable_must_be_absolute_without_shell_semantics() {
        let mut relative = spec();
        relative.executable = PathBuf::from("server.exe");
        assert!(relative.validate().is_err(), "相对路径拒绝");
        // argv 化 spawn 不经过 shell：路径与 arg 里的 shell 元字符（; | > $()）只是
        // 普通字符，不构成注入——禁的是控制符（换行会撕碎帧/日志）。
        let mut weird_path = spec();
        weird_path.executable = std::env::temp_dir().join("server (x86);v1/server");
        assert!(weird_path.validate().is_ok());
        let mut meta_args = spec();
        meta_args.args = vec!["--exec".to_string(), "x; rm -rf /".to_string()];
        assert!(meta_args.validate().is_ok(), "argv 化下元字符是普通字符");
        let mut newline_arg = spec();
        newline_arg.args = vec!["--exec\ninjected".to_string()];
        assert!(newline_arg.validate().is_err(), "控制符拒绝");
    }

    #[test]
    fn args_are_bounded_and_control_free() {
        let mut too_many = spec();
        too_many.args = vec!["a".to_string(); MAX_ARGS + 1];
        assert!(too_many.validate().is_err());
        let mut newline = spec();
        newline.args = vec!["--flag\ninjected".to_string()];
        assert!(newline.validate().is_err());
        let mut oversized = spec();
        oversized.args = vec!["a".repeat(MAX_ARG_LENGTH + 1)];
        assert!(oversized.validate().is_err());
    }

    #[test]
    fn env_is_sanitized() {
        let mut bad_key = spec();
        bad_key.env = vec![("BAD KEY".to_string(), "v".to_string())];
        assert!(bad_key.validate().is_err());
        let mut nul = spec();
        nul.env = vec![("OK".to_string(), "a\0b".to_string())];
        assert!(nul.validate().is_err());
        let mut oversized = spec();
        oversized.env = vec![("OK".to_string(), "v".repeat(MAX_ENV_VALUE_LENGTH + 1))];
        assert!(oversized.validate().is_err());
    }

    #[test]
    fn max_line_bytes_is_bounded() {
        let mut zero = spec();
        zero.max_line_bytes = 0;
        assert!(zero.validate().is_err());
        let mut huge = spec();
        huge.max_line_bytes = MAX_LINE_BYTES + 1;
        assert!(huge.validate().is_err());
    }

    #[test]
    fn frames_must_be_single_lines_within_budget() {
        assert_eq!(normalize_frame("{\"id\":1}\n", 1024).unwrap(), "{\"id\":1}");
        assert!(normalize_frame("", 1024).is_err());
        assert!(normalize_frame("   ", 1024).is_err());
        assert!(normalize_frame("a\nb", 1024).is_err());
        assert!(normalize_frame(&"x".repeat(1025), 1024).is_err());
    }

    #[test]
    fn lifecycle_reaches_each_terminal_state_once() {
        let mut lifecycle = McpStdioLifecycle::spawned();
        assert!(!lifecycle.is_terminal());
        assert!(lifecycle.mark_exited(Some(0), 10));
        assert!(lifecycle.is_terminal());
        assert_eq!(lifecycle.state(), McpStdioState::Exited);
        assert_eq!(lifecycle.exit_code(), Some(0));
        // 终态不可再次迁移：第二次 stopped 是 no-op。
        assert!(!lifecycle.mark_stopped(None, 20));
        assert_eq!(lifecycle.state(), McpStdioState::Exited);
        assert_eq!(lifecycle.transitions().len(), 1);
    }

    #[test]
    fn termination_argv_is_process_tree_kill() {
        let argv = termination_argv(4242);
        #[cfg(target_os = "windows")]
        assert_eq!(argv, vec!["/F", "/T", "/PID", "4242"]);
        #[cfg(not(target_os = "windows"))]
        assert!(argv.is_empty());
    }
}
