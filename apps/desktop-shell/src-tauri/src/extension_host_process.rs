//! 扩展宿主命令面：把 crate 里既有的受控 Extension Host 接到 Tauri 控制面。
//!
//! 职责边界（本模块只做接线，不重写宿主）：
//! 1. 命令层第一道闸：只接受**绝对可执行路径**（复用 crate 的
//!    `is_absolute_executable`），相对路径 / PATH 命令名 / shell 字符串一律拒绝；
//! 2. 把前端 camelCase 的启动请求收敛成 crate 校验过的 `ExtensionLaunchSpec`，
//!    安全规则（标识符、revision、args、预算上限）全部由 `spec.validate()` 承担；
//! 3. start / stop / status 三个命令，生命周期状态机复用 `ExtensionHostSupervisor`
//!    与 `ExtensionHostLifecycle`，本模块不发明新状态；
//! 4. 预算必须显式给出且落在 crate 上限内，绝不提供「无上限」缺省。
//!
//! 不向子进程注入密钥：进程环境由 crate 的 `env_clear()` + 固定 AWO_* 变量决定，
//! 命令层不传递任何凭据、token 或用户环境。

use std::path::Path;
use std::sync::Mutex;

use process_supervisor::extension_host::{
    is_absolute_executable, ExtensionHostBudget, ExtensionHostError, ExtensionHostSnapshot,
    ExtensionHostState, ExtensionHostSupervisor, ExtensionLaunchSpec,
};
use process_supervisor::resource_isolation::ResourceEnforcementLevel;
use serde::{Deserialize, Serialize};
use tauri::State;

/// 启动请求的预算；三项都必须显式给出，缺省即反序列化失败（不允许无上限）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHostBudgetRequest {
    pub max_memory_mb: u32,
    pub max_cpu_ms: u64,
    pub max_startup_ms: u64,
}

/// 启动请求：`executable` 必须是绝对可执行路径；`args` 是 argv，绝不经过 shell。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartExtensionHostRequest {
    pub extension_id: String,
    pub revision: u64,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub budget: ExtensionHostBudgetRequest,
}

/// 回给前端的监督快照；字段 camelCase，枚举值沿用 crate 的 snake_case 词汇。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHostSnapshotDto {
    pub protocol_version: String,
    pub extension_id: String,
    pub revision: u64,
    pub resource_enforcement: ResourceEnforcementLevel,
    pub state: ExtensionHostState,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub exit_code: Option<i32>,
    pub detail: Option<String>,
}

impl From<ExtensionHostSnapshot> for ExtensionHostSnapshotDto {
    fn from(snapshot: ExtensionHostSnapshot) -> Self {
        Self {
            protocol_version: snapshot.protocol_version,
            extension_id: snapshot.extension_id,
            revision: snapshot.revision,
            resource_enforcement: snapshot.resource_enforcement,
            state: snapshot.state,
            started_at_ms: snapshot.started_at_ms,
            updated_at_ms: snapshot.updated_at_ms,
            exit_code: snapshot.exit_code,
            detail: snapshot.detail,
        }
    }
}

/// 单实例监督器的共享状态。外层 `Mutex` 只用于把「读快照 → 判定 → 拉起/停止」串成
/// 临界区，避免并发命令在 crate 内部的原子槽位之外再做一次非原子 check-then-act。
pub struct ExtensionHostProcessState {
    supervisor: Mutex<ExtensionHostSupervisor>,
}

impl ExtensionHostProcessState {
    pub fn new() -> Self {
        Self {
            supervisor: Mutex::new(ExtensionHostSupervisor::new()),
        }
    }
}

impl Default for ExtensionHostProcessState {
    fn default() -> Self {
        Self::new()
    }
}

/// crate 错误 → 稳定错误码；细节只进本机日志，不回给前端。
fn error_code(error: &ExtensionHostError) -> &'static str {
    match error {
        ExtensionHostError::InvalidSpec(_) => "extension-host-spec-invalid",
        ExtensionHostError::AlreadyRunning => "extension-host-already-running",
        ExtensionHostError::NotRunning => "extension-host-not-running",
        ExtensionHostError::Io(_) => "extension-host-io-failed",
        ExtensionHostError::InvalidProtocol(_) => "extension-host-protocol-invalid",
        ExtensionHostError::ResponsePending => "extension-host-response-pending",
        ExtensionHostError::ResourceIsolation(_) => "extension-host-resource-isolation-failed",
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 把请求收敛成 crate 规格：绝对路径闸门 + `spec.validate()` 承担其余安全规则。
fn build_spec(request: &StartExtensionHostRequest) -> Result<ExtensionLaunchSpec, &'static str> {
    if !is_absolute_executable(Path::new(&request.executable)) {
        return Err("extension-host-executable-not-absolute");
    }
    let spec = ExtensionLaunchSpec {
        extension_id: request.extension_id.clone(),
        revision: request.revision,
        executable: Path::new(&request.executable).to_path_buf(),
        args: request.args.clone(),
        budget: ExtensionHostBudget {
            max_memory_mb: request.budget.max_memory_mb,
            max_cpu_ms: request.budget.max_cpu_ms,
            max_startup_ms: request.budget.max_startup_ms,
        },
    };
    spec.validate().map_err(|error| {
        eprintln!("[extension-host] spec rejected: {error}");
        "extension-host-spec-invalid"
    })?;
    Ok(spec)
}

/// 快照是否代表「同一 extension 仍在运行」——start 幂等判定的唯一依据。
fn is_same_running_extension(
    snapshot: &ExtensionHostSnapshot,
    extension_id: &str,
    revision: u64,
) -> bool {
    matches!(
        snapshot.state,
        ExtensionHostState::Spawned | ExtensionHostState::Healthy
    ) && snapshot.extension_id == extension_id
        && snapshot.revision == revision
}

/// 幂等 start：同一 extension/revision 已在运行 → 返回当前快照，不重复拉起；
/// 被别的 extension 占用 → 显式报忙；处于终态 → 先收敛槽位再拉起。
fn start_supervised(
    supervisor: &ExtensionHostSupervisor,
    request: &StartExtensionHostRequest,
    now_ms: u64,
) -> Result<ExtensionHostSnapshotDto, &'static str> {
    let spec = build_spec(request)?;
    if let Some(current) = supervisor
        .poll(now_ms)
        .map_err(|error| error_code(&error))?
    {
        if is_same_running_extension(&current, &spec.extension_id, spec.revision) {
            return Ok(current.into());
        }
        if matches!(
            current.state,
            ExtensionHostState::Spawned | ExtensionHostState::Healthy
        ) {
            return Err("extension-host-busy");
        }
        // 终态（Exited/Stopped/TimedOut/ResourceExceeded）：收敛槽位后允许重新拉起。
        supervisor
            .shutdown(now_ms)
            .map_err(|error| error_code(&error))?;
    }
    supervisor
        .spawn(spec, now_ms)
        .map(ExtensionHostSnapshotDto::from)
        .map_err(|error| error_code(&error))
}

/// 幂等 stop：未运行返回 `None`（crate 的 `shutdown` 已保证），不抛错。
fn stop_supervised(
    supervisor: &ExtensionHostSupervisor,
    now_ms: u64,
) -> Result<Option<ExtensionHostSnapshotDto>, &'static str> {
    supervisor
        .shutdown(now_ms)
        .map(|snapshot| snapshot.map(ExtensionHostSnapshotDto::from))
        .map_err(|error| error_code(&error))
}

/// 快照查询：未运行时返回 `None`；否则顺带执行启动期限与资源预算治理。
fn status_supervised(
    supervisor: &ExtensionHostSupervisor,
    now_ms: u64,
) -> Result<Option<ExtensionHostSnapshotDto>, &'static str> {
    supervisor
        .poll(now_ms)
        .map(|snapshot| snapshot.map(ExtensionHostSnapshotDto::from))
        .map_err(|error| error_code(&error))
}

/// 拉起扩展宿主。子进程的 stdin/stdout 只承载版本化 lifecycle IPC，不承载业务载荷。
#[tauri::command]
pub async fn extension_host_start(
    state: State<'_, ExtensionHostProcessState>,
    request: StartExtensionHostRequest,
) -> Result<ExtensionHostSnapshotDto, &'static str> {
    let supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "extension-host-state-poisoned")?;
    start_supervised(&supervisor, &request, now_ms())
}

/// 停止扩展宿主并回收进程与资源租约；未运行时是幂等空操作。
#[tauri::command]
pub async fn extension_host_stop(
    state: State<'_, ExtensionHostProcessState>,
) -> Result<Option<ExtensionHostSnapshotDto>, &'static str> {
    let supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "extension-host-state-poisoned")?;
    stop_supervised(&supervisor, now_ms())
}

/// 读取当前监督快照；未运行时返回 `null`。
#[tauri::command]
pub async fn extension_host_status(
    state: State<'_, ExtensionHostProcessState>,
) -> Result<Option<ExtensionHostSnapshotDto>, &'static str> {
    let supervisor = state
        .supervisor
        .lock()
        .map_err(|_| "extension-host-state-poisoned")?;
    status_supervised(&supervisor, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 跨平台绝对路径夹具：只用于规格校验，不用于真实 spawn。
    fn absolute_fixture() -> String {
        if cfg!(target_os = "windows") {
            "C:\\awo\\extension\\bin\\host.exe".to_string()
        } else {
            "/opt/awo/extension/bin/host".to_string()
        }
    }

    fn request() -> StartExtensionHostRequest {
        StartExtensionHostRequest {
            extension_id: "provider.local".to_string(),
            revision: 1,
            executable: absolute_fixture(),
            args: vec!["--transport".to_string(), "stdio".to_string()],
            budget: ExtensionHostBudgetRequest {
                max_memory_mb: 128,
                max_cpu_ms: 1_000,
                max_startup_ms: 100,
            },
        }
    }

    #[test]
    fn spec_build_accepts_absolute_executable_and_maps_budget() {
        let spec = build_spec(&request()).expect("valid spec");
        assert_eq!(spec.extension_id, "provider.local");
        assert_eq!(spec.revision, 1);
        assert!(spec.executable.is_absolute());
        assert_eq!(spec.args, vec!["--transport", "stdio"]);
        assert_eq!(spec.budget.max_memory_mb, 128);
        assert_eq!(spec.budget.max_cpu_ms, 1_000);
        assert_eq!(spec.budget.max_startup_ms, 100);
    }

    #[test]
    fn spec_build_rejects_relative_paths_and_shell_command_names() {
        for candidate in ["extension-host", "./bin/host", "host.exe", "sh -c host"] {
            let mut bad = request();
            bad.executable = candidate.to_string();
            assert!(
                matches!(
                    build_spec(&bad),
                    Err("extension-host-executable-not-absolute")
                ),
                "{candidate} 必须被拒绝"
            );
        }
    }

    #[test]
    fn spec_build_rejects_zero_and_unbounded_budgets() {
        // 0 = 未给出预算；超出 crate 上限 = 试图申请无上限资源。两者都必须 fail-closed。
        let mut zero = request();
        zero.budget.max_memory_mb = 0;
        assert!(matches!(
            build_spec(&zero),
            Err("extension-host-spec-invalid")
        ));

        let mut oversized = request();
        oversized.budget.max_memory_mb = 4_097;
        assert!(matches!(
            build_spec(&oversized),
            Err("extension-host-spec-invalid")
        ));

        let mut long_cpu = request();
        long_cpu.budget.max_cpu_ms = 3_600_001;
        assert!(matches!(
            build_spec(&long_cpu),
            Err("extension-host-spec-invalid")
        ));

        let mut long_startup = request();
        long_startup.budget.max_startup_ms = 60_001;
        assert!(matches!(
            build_spec(&long_startup),
            Err("extension-host-spec-invalid")
        ));
    }

    #[test]
    fn spec_build_rejects_control_characters_and_unsafe_identifiers() {
        let mut injected = request();
        injected.args = vec!["--flag\ninjected".to_string()];
        assert!(matches!(
            build_spec(&injected),
            Err("extension-host-spec-invalid")
        ));

        let mut bad_id = request();
        bad_id.extension_id = "bad id".to_string();
        assert!(matches!(
            build_spec(&bad_id),
            Err("extension-host-spec-invalid")
        ));

        let mut zero_revision = request();
        zero_revision.revision = 0;
        assert!(matches!(
            build_spec(&zero_revision),
            Err("extension-host-spec-invalid")
        ));
    }

    #[test]
    fn status_and_stop_are_idempotent_when_nothing_is_running() {
        let supervisor = ExtensionHostSupervisor::new();
        assert!(status_supervised(&supervisor, 1).expect("status").is_none());
        assert!(stop_supervised(&supervisor, 2).expect("stop").is_none());
        // 重复停止仍是幂等空操作。
        assert!(stop_supervised(&supervisor, 3)
            .expect("stop again")
            .is_none());
        assert!(!supervisor.is_alive());
    }

    #[test]
    fn failed_start_leaves_supervisor_empty_and_retryable() {
        let supervisor = ExtensionHostSupervisor::new();
        let mut bad = request();
        bad.executable = PathBuf::from("relative-host").to_string_lossy().to_string();
        assert!(matches!(
            start_supervised(&supervisor, &bad, 1),
            Err("extension-host-executable-not-absolute")
        ));
        // 失败不污染状态：仍然是「未运行」。
        assert!(status_supervised(&supervisor, 2).expect("status").is_none());
    }

    #[test]
    fn same_running_extension_predicate_matches_only_identity_and_live_states() {
        let mut snapshot = ExtensionHostSnapshot {
            protocol_version: "awo.extension-host.v1".to_string(),
            extension_id: "provider.local".to_string(),
            revision: 1,
            resource_enforcement: ResourceEnforcementLevel::RequestedOnly,
            state: ExtensionHostState::Spawned,
            started_at_ms: 1,
            updated_at_ms: 1,
            exit_code: None,
            detail: None,
        };
        assert!(is_same_running_extension(&snapshot, "provider.local", 1));
        assert!(!is_same_running_extension(&snapshot, "provider.local", 2));
        assert!(!is_same_running_extension(&snapshot, "other.local", 1));
        snapshot.state = ExtensionHostState::Healthy;
        assert!(is_same_running_extension(&snapshot, "provider.local", 1));
        for terminal in [
            ExtensionHostState::Exited,
            ExtensionHostState::Stopped,
            ExtensionHostState::TimedOut,
            ExtensionHostState::ResourceExceeded,
        ] {
            snapshot.state = terminal;
            assert!(!is_same_running_extension(&snapshot, "provider.local", 1));
        }
    }

    #[test]
    fn snapshot_dto_serializes_camel_case_fields_with_crate_vocabulary() {
        let dto = ExtensionHostSnapshotDto {
            protocol_version: "awo.extension-host.v1".to_string(),
            extension_id: "provider.local".to_string(),
            revision: 1,
            resource_enforcement: ResourceEnforcementLevel::RequestedOnly,
            state: ExtensionHostState::Spawned,
            started_at_ms: 7,
            updated_at_ms: 9,
            exit_code: None,
            detail: None,
        };
        let json = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(json["protocolVersion"], "awo.extension-host.v1");
        assert_eq!(json["extensionId"], "provider.local");
        assert_eq!(json["resourceEnforcement"], "requested_only");
        assert_eq!(json["state"], "spawned");
        assert_eq!(json["startedAtMs"], 7);
        assert!(json["exitCode"].is_null());
        // 快照里不得出现任何 secret/token 字段。
        assert!(json.get("secret").is_none());
    }

    #[test]
    fn start_request_deserializes_camel_case_and_rejects_unknown_fields() {
        let parsed: StartExtensionHostRequest = serde_json::from_str(
            r#"{"extensionId":"provider.local","revision":1,"executable":"/opt/awo/host","args":["--x"],
                "budget":{"maxMemoryMb":64,"maxCpuMs":500,"maxStartupMs":50}}"#,
        )
        .expect("camelCase request");
        assert_eq!(parsed.extension_id, "provider.local");
        assert_eq!(parsed.budget.max_memory_mb, 64);
        // 缺预算 → 反序列化失败（显式给出预算，绝不提供无上限缺省）。
        assert!(serde_json::from_str::<StartExtensionHostRequest>(
            r#"{"extensionId":"provider.local","revision":1,"executable":"/opt/awo/host"}"#
        )
        .is_err());
        // 未知字段 → 拒绝，避免前端悄悄夹带未审查的启动参数。
        assert!(serde_json::from_str::<StartExtensionHostRequest>(
            r#"{"extensionId":"provider.local","revision":1,"executable":"/opt/awo/host",
                "budget":{"maxMemoryMb":64,"maxCpuMs":500,"maxStartupMs":50},"env":{"AWO_EXTRA":"x"}}"#
        )
        .is_err());
    }

    #[test]
    fn error_codes_are_stable_for_every_crate_error_variant() {
        assert_eq!(
            error_code(&ExtensionHostError::InvalidSpec("x".to_string())),
            "extension-host-spec-invalid"
        );
        assert_eq!(
            error_code(&ExtensionHostError::AlreadyRunning),
            "extension-host-already-running"
        );
        assert_eq!(
            error_code(&ExtensionHostError::NotRunning),
            "extension-host-not-running"
        );
        assert_eq!(
            error_code(&ExtensionHostError::Io("x".to_string())),
            "extension-host-io-failed"
        );
        assert_eq!(
            error_code(&ExtensionHostError::InvalidProtocol("x".to_string())),
            "extension-host-protocol-invalid"
        );
        assert_eq!(
            error_code(&ExtensionHostError::ResponsePending),
            "extension-host-response-pending"
        );
        assert_eq!(
            error_code(&ExtensionHostError::ResourceIsolation("x".to_string())),
            "extension-host-resource-isolation-failed"
        );
    }
}
