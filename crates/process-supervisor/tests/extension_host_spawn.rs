//! 一个文件=一种作用：扩展宿主 **真实 spawn** 的端到端集成测试。
//!
//! 用 `env!("CARGO_BIN_EXE_extension_host_fixture")` 取得夹具二进制的绝对路径
//! （cargo 为集成测试提供的机制，天然跨平台，无需 Node 或平台特定程序），
//! 覆盖三条真实进程路径：正常握手 → Healthy → 停止、启动超时、子进程提前退出。
//!
//! 断言不只比较状态枚举：握手响应里回显的 `AWO_*` 与传入 spec 一致，证明
//! 子进程确实被拉起、`env_clear` + 固定注入确实生效、版本化 IPC 真的走了一个来回。

use process_supervisor::extension_host::{
    ExtensionHostBudget, ExtensionHostError, ExtensionHostOperation, ExtensionHostRequest,
    ExtensionHostSnapshot, ExtensionHostState, ExtensionHostSupervisor, ExtensionLaunchSpec,
    EXTENSION_HOST_PROTOCOL_VERSION,
};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 夹具二进制的绝对路径，由 cargo 在编译集成测试时注入。
const FIXTURE_BINARY: &str = env!("CARGO_BIN_EXE_extension_host_fixture");

fn fixture_path() -> PathBuf {
    let path = PathBuf::from(FIXTURE_BINARY);
    assert!(
        path.is_absolute(),
        "夹具二进制路径必须是绝对路径，实际为 {path:?}"
    );
    path
}

fn launch_spec(mode: &str, max_startup_ms: u64) -> ExtensionLaunchSpec {
    ExtensionLaunchSpec {
        extension_id: "provider.local".to_string(),
        revision: 1,
        executable: fixture_path(),
        args: vec!["--mode".to_string(), mode.to_string()],
        budget: ExtensionHostBudget {
            max_memory_mb: 128,
            max_cpu_ms: 1000,
            max_startup_ms,
        },
    }
}

fn lifecycle_request(request_id: &str, operation: ExtensionHostOperation) -> ExtensionHostRequest {
    ExtensionHostRequest {
        protocol_version: EXTENSION_HOST_PROTOCOL_VERSION.to_string(),
        request_id: request_id.to_string(),
        extension_id: "provider.local".to_string(),
        revision: 1,
        operation,
    }
}

/// 宿主读取响应是非阻塞的：轮询到夹具写回为止，超时则判定为失败。
fn await_lifecycle_response(
    supervisor: &ExtensionHostSupervisor,
    request: &ExtensionHostRequest,
    now_ms: u64,
) -> ExtensionHostSnapshot {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match supervisor.read_lifecycle_response(request, now_ms) {
            Ok(snapshot) => return snapshot,
            Err(ExtensionHostError::ResponsePending) => {
                assert!(Instant::now() < deadline, "等待夹具响应超时");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(other) => panic!("读取 lifecycle 响应失败: {other:?}"),
        }
    }
}

#[test]
fn spawn_handshake_reaches_healthy_and_shutdown_reaps_child() {
    let supervisor = ExtensionHostSupervisor::new();
    let spawned = supervisor
        .spawn(launch_spec("ready", 5_000), 0)
        .expect("夹具应能被真实拉起");
    assert_eq!(spawned.state, ExtensionHostState::Spawned);
    assert!(supervisor.is_alive(), "spawn 后夹具子进程必须真实存活");

    // Health 握手：请求真的写进了子进程 stdin，响应真的从子进程 stdout 读回。
    let health = lifecycle_request("health-001", ExtensionHostOperation::Health);
    supervisor
        .send_lifecycle(health.clone(), 0)
        .expect("发送 health 请求");
    let healthy = await_lifecycle_response(&supervisor, &health, 0);
    assert_eq!(healthy.state, ExtensionHostState::Healthy);

    // 回显断言：证明真的发生了进程交互，且 env_clear + 固定 AWO_* 注入生效。
    let detail = healthy.detail.expect("health 响应应带回 detail 回显");
    assert!(detail.contains("AWO_EXTENSION_HOST=1"), "{detail}");
    assert!(
        detail.contains("AWO_EXTENSION_ID=provider.local"),
        "{detail}"
    );
    assert!(detail.contains("AWO_EXTENSION_REVISION=1"), "{detail}");
    assert!(
        detail.contains("AWO_EXTENSION_MAX_MEMORY_MB=128"),
        "{detail}"
    );
    assert!(detail.contains("AWO_EXTENSION_MAX_CPU_MS=1000"), "{detail}");
    assert!(
        detail.contains("AWO_EXTENSION_MAX_STARTUP_MS=5000"),
        "{detail}"
    );
    // 继承环境被清空：子进程只剩宿主注入的 8 个 AWO_* 变量。
    assert!(detail.contains("env_count=8"), "{detail}");

    // 优雅停止：再走一次版本化 IPC，宿主 reap 后状态推进到 Stopped。
    let shutdown = lifecycle_request("shutdown-001", ExtensionHostOperation::Shutdown);
    supervisor
        .send_lifecycle(shutdown.clone(), 1)
        .expect("发送 shutdown 请求");
    let stopped = await_lifecycle_response(&supervisor, &shutdown, 1);
    assert_eq!(stopped.state, ExtensionHostState::Stopped);
    assert!(!supervisor.is_alive(), "停止后夹具子进程必须真的没了");
}

#[test]
fn startup_timeout_terminates_unresponsive_child() {
    let supervisor = ExtensionHostSupervisor::new();
    let spawned = supervisor
        .spawn(launch_spec("timeout", 50), 0)
        .expect("夹具应能被真实拉起");
    assert_eq!(spawned.state, ExtensionHostState::Spawned);
    assert!(supervisor.is_alive(), "超时前夹具子进程必须真实存活");

    // 用合成的时钟越过 50ms 启动期限，避免真实长等待。
    let timed_out = supervisor
        .poll(1_000)
        .expect("poll 不应报错")
        .expect("存在受监督子进程");
    assert_eq!(timed_out.state, ExtensionHostState::TimedOut);
    assert!(
        timed_out
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("startup deadline")),
        "超时 detail 应说明启动期限: {:?}",
        timed_out.detail
    );
    assert!(
        !supervisor.is_alive(),
        "超时后夹具子进程必须被 kill 并 reap"
    );
}

#[test]
fn early_exit_is_observed_as_exited_with_fixture_code() {
    let supervisor = ExtensionHostSupervisor::new();
    let spawned = supervisor
        .spawn(launch_spec("crash", 60_000), 0)
        .expect("夹具应能被真实拉起");
    assert_eq!(spawned.state, ExtensionHostState::Spawned);

    let deadline = Instant::now() + Duration::from_secs(5);
    let exited = loop {
        let snapshot = supervisor
            .poll(0)
            .expect("poll 不应报错")
            .expect("存在受监督子进程");
        if snapshot.state == ExtensionHostState::Exited {
            break snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "夹具未按预期提前退出: {snapshot:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    // 退出码 3 只有真实跑起来的夹具才会产生，证明子进程确实被执行过。
    assert_eq!(exited.exit_code, Some(3), "应 reap 到夹具的退出码 3");
    assert!(!supervisor.is_alive());
}
