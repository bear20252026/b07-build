//! 受控 Extension Host：监督进程生命周期与最小 JSON IPC。
//!
//! 该模块不解析 extension 业务、不下载代码、不授权 capability，也不向子进程注入密钥。
//! 它只接收已经由上层 Activation Planner 选择的单个扩展制品，并使用直接可执行路径启动。

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

pub const EXTENSION_HOST_PROTOCOL_VERSION: &str = "awo.extension-host.v1";
const MAX_ARGS: usize = 32;
const MAX_ARG_LENGTH: usize = 1024;
const MAX_MEMORY_MB: u32 = 4096;
const MAX_CPU_MS: u64 = 3_600_000;
const MAX_STARTUP_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionHostBudget {
    pub max_memory_mb: u32,
    pub max_cpu_ms: u64,
    pub max_startup_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionLaunchSpec {
    pub extension_id: String,
    pub revision: u64,
    /// 已经经过来源摘要核验的绝对可执行路径；不得使用 shell 字符串。
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub budget: ExtensionHostBudget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionHostState {
    Prepared,
    Spawned,
    Healthy,
    TimedOut,
    Exited,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionHostSnapshot {
    pub protocol_version: String,
    pub extension_id: String,
    pub revision: u64,
    pub state: ExtensionHostState,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub exit_code: Option<i32>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionHostOperation {
    Health,
    Shutdown,
}

/// Host 与 extension 间仅允许 lifecycle IPC；不存在 tool、secret、DB、shell 或网络操作字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionHostRequest {
    pub protocol_version: String,
    pub request_id: String,
    pub extension_id: String,
    pub revision: u64,
    pub operation: ExtensionHostOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionHostResponseStatus {
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionHostResponse {
    pub protocol_version: String,
    pub request_id: String,
    pub status: ExtensionHostResponseStatus,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtensionHostError {
    InvalidSpec(String),
    AlreadyRunning,
    NotRunning,
    Io(String),
    InvalidProtocol(String),
}

impl std::fmt::Display for ExtensionHostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSpec(detail) => {
                write!(formatter, "invalid extension launch spec: {detail}")
            }
            Self::AlreadyRunning => write!(formatter, "extension host is already running"),
            Self::NotRunning => write!(formatter, "extension host is not running"),
            Self::Io(detail) => write!(formatter, "extension host io error: {detail}"),
            Self::InvalidProtocol(detail) => {
                write!(formatter, "invalid extension host protocol: {detail}")
            }
        }
    }
}

impl std::error::Error for ExtensionHostError {}

fn validate_identifier(value: &str, label: &str) -> Result<(), ExtensionHostError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '_' | ':' | '-')
                    && !(index == 0 && matches!(character, '.' | '_' | ':' | '-'))
        });
    if valid {
        Ok(())
    } else {
        Err(ExtensionHostError::InvalidSpec(format!(
            "{label} must be a safe 1-128 character identifier"
        )))
    }
}

fn validate_budget(budget: &ExtensionHostBudget) -> Result<(), ExtensionHostError> {
    if budget.max_memory_mb == 0 || budget.max_memory_mb > MAX_MEMORY_MB {
        return Err(ExtensionHostError::InvalidSpec(format!(
            "max_memory_mb must be 1-{MAX_MEMORY_MB}"
        )));
    }
    if budget.max_cpu_ms == 0 || budget.max_cpu_ms > MAX_CPU_MS {
        return Err(ExtensionHostError::InvalidSpec(format!(
            "max_cpu_ms must be 1-{MAX_CPU_MS}"
        )));
    }
    if budget.max_startup_ms == 0 || budget.max_startup_ms > MAX_STARTUP_MS {
        return Err(ExtensionHostError::InvalidSpec(format!(
            "max_startup_ms must be 1-{MAX_STARTUP_MS}"
        )));
    }
    Ok(())
}

impl ExtensionLaunchSpec {
    pub fn validate(&self) -> Result<(), ExtensionHostError> {
        validate_identifier(&self.extension_id, "extension_id")?;
        if self.revision == 0 {
            return Err(ExtensionHostError::InvalidSpec(
                "revision must be greater than zero".to_string(),
            ));
        }
        if !self.executable.is_absolute() || self.executable.as_os_str().is_empty() {
            return Err(ExtensionHostError::InvalidSpec(
                "executable must be an absolute direct path".to_string(),
            ));
        }
        if self.args.len() > MAX_ARGS
            || self
                .args
                .iter()
                .any(|arg| arg.len() > MAX_ARG_LENGTH || arg.contains(['\r', '\n', '\0']))
        {
            return Err(ExtensionHostError::InvalidSpec(format!(
                "args must contain at most {MAX_ARGS} values without control characters"
            )));
        }
        validate_budget(&self.budget)
    }
}

impl ExtensionHostRequest {
    pub fn validate(&self) -> Result<(), ExtensionHostError> {
        if self.protocol_version != EXTENSION_HOST_PROTOCOL_VERSION {
            return Err(ExtensionHostError::InvalidProtocol(
                "unsupported protocol_version".to_string(),
            ));
        }
        validate_identifier(&self.request_id, "request_id")?;
        validate_identifier(&self.extension_id, "extension_id")?;
        if self.revision == 0 {
            return Err(ExtensionHostError::InvalidProtocol(
                "revision must be greater than zero".to_string(),
            ));
        }
        Ok(())
    }

    pub fn to_json_line(&self) -> Result<Vec<u8>, ExtensionHostError> {
        self.validate()?;
        let mut bytes =
            serde_json::to_vec(self).map_err(|error| ExtensionHostError::Io(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

impl ExtensionHostResponse {
    pub fn parse_json_line(line: &str) -> Result<Self, ExtensionHostError> {
        let response = serde_json::from_str::<Self>(line)
            .map_err(|error| ExtensionHostError::InvalidProtocol(error.to_string()))?;
        if response.protocol_version != EXTENSION_HOST_PROTOCOL_VERSION {
            return Err(ExtensionHostError::InvalidProtocol(
                "unsupported response protocol_version".to_string(),
            ));
        }
        validate_identifier(&response.request_id, "request_id")?;
        Ok(response)
    }
}

#[derive(Debug)]
struct ManagedExtensionChild {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    snapshot: ExtensionHostSnapshot,
    budget: ExtensionHostBudget,
}

/// 纯状态机，用于在启动前和无真实进程的测试中验证 deadline；运行时 supervisor 复用同一状态约束。
#[derive(Debug, Clone)]
pub struct ExtensionHostLifecycle {
    spec: ExtensionLaunchSpec,
    snapshot: ExtensionHostSnapshot,
}

impl ExtensionHostLifecycle {
    pub fn prepared(spec: ExtensionLaunchSpec, now_ms: u64) -> Result<Self, ExtensionHostError> {
        spec.validate()?;
        Ok(Self {
            snapshot: ExtensionHostSnapshot {
                protocol_version: EXTENSION_HOST_PROTOCOL_VERSION.to_string(),
                extension_id: spec.extension_id.clone(),
                revision: spec.revision,
                state: ExtensionHostState::Prepared,
                started_at_ms: now_ms,
                updated_at_ms: now_ms,
                exit_code: None,
                detail: None,
            },
            spec,
        })
    }

    pub fn mark_spawned(&mut self, now_ms: u64) -> &ExtensionHostSnapshot {
        self.snapshot.state = ExtensionHostState::Spawned;
        self.snapshot.updated_at_ms = now_ms;
        &self.snapshot
    }

    pub fn mark_healthy(
        &mut self,
        now_ms: u64,
    ) -> Result<&ExtensionHostSnapshot, ExtensionHostError> {
        self.check_startup_timeout(now_ms);
        if self.snapshot.state == ExtensionHostState::TimedOut {
            return Err(ExtensionHostError::InvalidProtocol(
                "health arrived after startup deadline".to_string(),
            ));
        }
        if self.snapshot.state != ExtensionHostState::Spawned {
            return Err(ExtensionHostError::InvalidProtocol(
                "health is only valid after spawn".to_string(),
            ));
        }
        self.snapshot.state = ExtensionHostState::Healthy;
        self.snapshot.updated_at_ms = now_ms;
        Ok(&self.snapshot)
    }

    pub fn check_startup_timeout(&mut self, now_ms: u64) -> bool {
        if self.snapshot.state == ExtensionHostState::Spawned
            && now_ms.saturating_sub(self.snapshot.started_at_ms) > self.spec.budget.max_startup_ms
        {
            self.snapshot.state = ExtensionHostState::TimedOut;
            self.snapshot.updated_at_ms = now_ms;
            self.snapshot.detail =
                Some("extension did not report health before startup deadline".to_string());
            return true;
        }
        false
    }

    pub fn snapshot(&self) -> ExtensionHostSnapshot {
        self.snapshot.clone()
    }
}

/// 单 extension 进程监督器。无 shell、无继承环境、无 secret 注入；调用方负责将 lifecycle IPC 映射到真实 policy。
pub struct ExtensionHostSupervisor {
    child: Mutex<Option<ManagedExtensionChild>>,
}

impl ExtensionHostSupervisor {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub fn spawn(
        &self,
        spec: ExtensionLaunchSpec,
        now_ms: u64,
    ) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        spec.validate()?;
        let mut slot = self
            .child
            .lock()
            .map_err(|_| ExtensionHostError::Io("extension host mutex poisoned".to_string()))?;
        if slot.is_some() {
            return Err(ExtensionHostError::AlreadyRunning);
        }
        let mut lifecycle = ExtensionHostLifecycle::prepared(spec.clone(), now_ms)?;
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .env_clear()
            .env("AWO_EXTENSION_HOST", "1")
            .env("AWO_EXTENSION_ID", &spec.extension_id)
            .env("AWO_EXTENSION_REVISION", spec.revision.to_string())
            .env(
                "AWO_EXTENSION_MAX_MEMORY_MB",
                spec.budget.max_memory_mb.to_string(),
            )
            .env(
                "AWO_EXTENSION_MAX_CPU_MS",
                spec.budget.max_cpu_ms.to_string(),
            )
            .env(
                "AWO_EXTENSION_MAX_STARTUP_MS",
                spec.budget.max_startup_ms.to_string(),
            )
            .env("AWO_EXIT_WITH_PARENT", "1")
            .env("AWO_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| ExtensionHostError::Io(error.to_string()))?;
        let stdin = child.stdin.take().ok_or_else(|| {
            ExtensionHostError::Io("failed to create extension stdin".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ExtensionHostError::Io("failed to create extension stdout".to_string())
        })?;
        let snapshot = lifecycle.mark_spawned(now_ms).clone();
        *slot = Some(ManagedExtensionChild {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            snapshot: snapshot.clone(),
            budget: spec.budget,
        });
        Ok(snapshot)
    }

    /// 仅发送版本化 lifecycle IPC；不会发送任务目标、文件内容、token、凭据或任意工具参数。
    pub fn send_lifecycle(
        &self,
        request: ExtensionHostRequest,
        now_ms: u64,
    ) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        let line = request.to_json_line()?;
        let mut slot = self
            .child
            .lock()
            .map_err(|_| ExtensionHostError::Io("extension host mutex poisoned".to_string()))?;
        let managed = slot.as_mut().ok_or(ExtensionHostError::NotRunning)?;
        if managed.snapshot.extension_id != request.extension_id
            || managed.snapshot.revision != request.revision
        {
            return Err(ExtensionHostError::InvalidProtocol(
                "request extension identity does not match supervised child".to_string(),
            ));
        }
        managed
            .stdin
            .write_all(&line)
            .map_err(|error| ExtensionHostError::Io(error.to_string()))?;
        managed
            .stdin
            .flush()
            .map_err(|error| ExtensionHostError::Io(error.to_string()))?;
        if request.operation == ExtensionHostOperation::Health
            && now_ms.saturating_sub(managed.snapshot.started_at_ms) > managed.budget.max_startup_ms
        {
            let _ = managed.child.kill();
            managed.snapshot.state = ExtensionHostState::TimedOut;
            managed.snapshot.detail =
                Some("extension did not report health before startup deadline".to_string());
            managed.snapshot.updated_at_ms = now_ms;
        }
        Ok(managed.snapshot.clone())
    }

    /// 只从监督子进程 stdout 消费一条已版本化的 lifecycle 响应；健康状态不会因写入成功而提前提升。
    /// 调用方必须继续调用 `poll` 执行启动期限治理，此方法不会创建后台读取线程。
    pub fn read_lifecycle_response(
        &self,
        request: &ExtensionHostRequest,
        now_ms: u64,
    ) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        request.validate()?;
        let mut slot = self
            .child
            .lock()
            .map_err(|_| ExtensionHostError::Io("extension host mutex poisoned".to_string()))?;
        let managed = slot.as_mut().ok_or(ExtensionHostError::NotRunning)?;
        if managed.snapshot.extension_id != request.extension_id
            || managed.snapshot.revision != request.revision
        {
            return Err(ExtensionHostError::InvalidProtocol(
                "response extension identity does not match supervised child".to_string(),
            ));
        }
        let mut line = String::new();
        let bytes = managed
            .stdout
            .read_line(&mut line)
            .map_err(|error| ExtensionHostError::Io(error.to_string()))?;
        if bytes == 0 {
            return Err(ExtensionHostError::InvalidProtocol(
                "extension closed stdout before lifecycle response".to_string(),
            ));
        }
        let response = ExtensionHostResponse::parse_json_line(line.trim_end())?;
        if response.request_id != request.request_id {
            return Err(ExtensionHostError::InvalidProtocol(
                "response request_id does not match lifecycle request".to_string(),
            ));
        }
        match (request.operation.clone(), response.status) {
            (ExtensionHostOperation::Health, ExtensionHostResponseStatus::Ready) => {
                if now_ms.saturating_sub(managed.snapshot.started_at_ms)
                    > managed.budget.max_startup_ms
                {
                    let _ = managed.child.kill();
                    managed.snapshot.state = ExtensionHostState::TimedOut;
                    managed.snapshot.detail =
                        Some("extension reported health after startup deadline".to_string());
                } else if managed.snapshot.state == ExtensionHostState::Spawned {
                    managed.snapshot.state = ExtensionHostState::Healthy;
                    managed.snapshot.detail = response.detail;
                }
                managed.snapshot.updated_at_ms = now_ms;
            }
            (_, ExtensionHostResponseStatus::Error) => {
                managed.snapshot.detail = response
                    .detail
                    .or_else(|| Some("extension lifecycle response returned error".to_string()));
                managed.snapshot.updated_at_ms = now_ms;
            }
            (ExtensionHostOperation::Shutdown, ExtensionHostResponseStatus::Ready) => {
                managed.snapshot.state = ExtensionHostState::Stopped;
                managed.snapshot.updated_at_ms = now_ms;
            }
        }
        Ok(managed.snapshot.clone())
    }

    pub fn poll(&self, now_ms: u64) -> Result<Option<ExtensionHostSnapshot>, ExtensionHostError> {
        let mut slot = self
            .child
            .lock()
            .map_err(|_| ExtensionHostError::Io("extension host mutex poisoned".to_string()))?;
        let Some(managed) = slot.as_mut() else {
            return Ok(None);
        };
        if managed.snapshot.state == ExtensionHostState::Spawned
            && now_ms.saturating_sub(managed.snapshot.started_at_ms) > managed.budget.max_startup_ms
        {
            let _ = managed.child.kill();
            managed.snapshot.state = ExtensionHostState::TimedOut;
            managed.snapshot.detail =
                Some("extension did not report health before startup deadline".to_string());
            managed.snapshot.updated_at_ms = now_ms;
        } else if let Some(status) = managed
            .child
            .try_wait()
            .map_err(|error| ExtensionHostError::Io(error.to_string()))?
        {
            managed.snapshot.state = ExtensionHostState::Exited;
            managed.snapshot.exit_code = status.code();
            managed.snapshot.updated_at_ms = now_ms;
        }
        Ok(Some(managed.snapshot.clone()))
    }

    pub fn shutdown(
        &self,
        now_ms: u64,
    ) -> Result<Option<ExtensionHostSnapshot>, ExtensionHostError> {
        let mut slot = self
            .child
            .lock()
            .map_err(|_| ExtensionHostError::Io("extension host mutex poisoned".to_string()))?;
        let Some(mut managed) = slot.take() else {
            return Ok(None);
        };
        let _ = managed.child.kill();
        let _ = managed.child.wait();
        managed.snapshot.state = ExtensionHostState::Stopped;
        managed.snapshot.updated_at_ms = now_ms;
        Ok(Some(managed.snapshot))
    }

    pub fn is_alive(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut slot| {
                slot.as_mut()
                    .and_then(|managed| managed.child.try_wait().ok())
                    .map(|status| status.is_none())
            })
            .unwrap_or(false)
    }
}

impl Default for ExtensionHostSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

pub fn is_absolute_executable(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ExtensionLaunchSpec {
        ExtensionLaunchSpec {
            extension_id: "provider.local".to_string(),
            revision: 1,
            executable: std::env::current_exe().expect("test executable path"),
            args: vec![],
            budget: ExtensionHostBudget {
                max_memory_mb: 128,
                max_cpu_ms: 1000,
                max_startup_ms: 100,
            },
        }
    }

    #[test]
    fn launch_spec_rejects_relative_paths_and_out_of_range_budgets() {
        let mut invalid = spec();
        invalid.executable = PathBuf::from("extension-bin");
        assert!(matches!(
            invalid.validate(),
            Err(ExtensionHostError::InvalidSpec(_))
        ));
        let mut too_large = spec();
        too_large.budget.max_memory_mb = MAX_MEMORY_MB + 1;
        assert!(matches!(
            too_large.validate(),
            Err(ExtensionHostError::InvalidSpec(_))
        ));
    }

    #[test]
    fn lifecycle_requires_health_before_deadline_and_records_timeout_without_running_code() {
        let mut lifecycle = ExtensionHostLifecycle::prepared(spec(), 10).expect("prepared");
        lifecycle.mark_spawned(10);
        assert!(!lifecycle.check_startup_timeout(110));
        assert!(lifecycle.check_startup_timeout(111));
        assert_eq!(lifecycle.snapshot().state, ExtensionHostState::TimedOut);
        assert!(matches!(
            lifecycle.mark_healthy(112),
            Err(ExtensionHostError::InvalidProtocol(_))
        ));
    }

    #[test]
    fn lifecycle_ipc_is_versioned_minimal_and_rejects_wrong_versions() {
        let request = ExtensionHostRequest {
            protocol_version: EXTENSION_HOST_PROTOCOL_VERSION.to_string(),
            request_id: "request-001".to_string(),
            extension_id: "provider.local".to_string(),
            revision: 1,
            operation: ExtensionHostOperation::Health,
        };
        let line = String::from_utf8(request.to_json_line().expect("json line")).expect("utf8");
        assert!(line.ends_with('\n'));
        assert!(!line.contains("secret"));
        let response = ExtensionHostResponse::parse_json_line(
            r#"{"protocol_version":"awo.extension-host.v1","request_id":"request-001","status":"ready","detail":null}"#,
        )
        .expect("response");
        assert_eq!(response.status, ExtensionHostResponseStatus::Ready);
        assert!(matches!(
            ExtensionHostResponse::parse_json_line(
                r#"{"protocol_version":"awo.extension-host.v2","request_id":"request-001","status":"ready","detail":null}"#
            ),
            Err(ExtensionHostError::InvalidProtocol(_))
        ));
    }
}
