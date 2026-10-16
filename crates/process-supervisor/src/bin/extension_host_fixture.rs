//! 一个文件=一种作用：扩展宿主的**测试夹具二进制**，供 `tests/` 做真实 spawn 端到端测试。
//!
//! 它只做三件事：读 stdin 的版本化 lifecycle 请求行、写 stdout 的版本化响应行、按需退出。
//! 不碰文件系统、不碰网络、不读用户数据；也不需要任何新依赖（仅 std + serde_json）。
//!
//! 模式由 `--mode <ready|timeout|crash>` 选择：
//! - `ready`（默认）：正常应答每一条请求；收到 `shutdown` 后退出（退出码 0）。
//! - `timeout`：只读请求、故意不写响应，等待宿主在启动期限内终止本进程。
//! - `crash`：不读 stdin，立即以固定退出码退出，用于触发宿主的 `Exited` 观测。

use process_supervisor::extension_host::{
    ExtensionHostOperation, ExtensionHostRequest, ExtensionHostResponse,
    ExtensionHostResponseStatus, EXTENSION_HOST_PROTOCOL_VERSION,
};
use std::io::{BufRead, Write};

/// `crash` 模式使用的固定退出码，测试会断言宿主 reap 到的就是它。
const CRASH_EXIT_CODE: i32 = 3;

enum Mode {
    Ready,
    Timeout,
    Crash,
}

fn parse_mode() -> Mode {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--mode" {
            return match args.next().as_deref() {
                Some("timeout") => Mode::Timeout,
                Some("crash") => Mode::Crash,
                _ => Mode::Ready,
            };
        }
    }
    Mode::Ready
}

fn main() {
    match parse_mode() {
        Mode::Ready => run_ready(),
        Mode::Timeout => run_timeout(),
        Mode::Crash => std::process::exit(CRASH_EXIT_CODE),
    }
}

/// 正常模式：逐行读请求，逐行写响应；`shutdown` 后退出。
fn run_ready() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.lock().read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<ExtensionHostRequest>(trimmed) else {
            continue;
        };
        let response = ExtensionHostResponse {
            protocol_version: EXTENSION_HOST_PROTOCOL_VERSION.to_string(),
            request_id: request.request_id.clone(),
            status: ExtensionHostResponseStatus::Ready,
            // 回显自己实际看到的环境，供测试断言 `env_clear` + 固定 AWO_* 注入生效。
            detail: Some(environment_report()),
        };
        if write_response(&mut stdout, &response).is_err() {
            break;
        }
        if request.operation == ExtensionHostOperation::Shutdown {
            break;
        }
    }
}

/// 超时模式：读到请求也绝不响应，保持存活直到被宿主终止或 stdin 关闭。
fn run_timeout() {
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.lock().read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

fn write_response(
    stdout: &mut std::io::Stdout,
    response: &ExtensionHostResponse,
) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(response).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    stdout.write_all(&bytes)?;
    stdout.flush()
}

/// 报告本进程实际持有的环境变量数量与关键 `AWO_*` 值。
/// `env_count` 等于宿主注入的 8 个变量时，即证明 `env_clear` 清空了继承环境。
fn environment_report() -> String {
    let value = |key: &str| std::env::var(key).unwrap_or_else(|_| "<unset>".to_string());
    format!(
        "env_count={count};AWO_EXTENSION_HOST={host};AWO_EXTENSION_ID={id};\
         AWO_EXTENSION_REVISION={revision};AWO_EXTENSION_MAX_MEMORY_MB={memory};\
         AWO_EXTENSION_MAX_CPU_MS={cpu};AWO_EXTENSION_MAX_STARTUP_MS={startup}",
        count = std::env::vars_os().count(),
        host = value("AWO_EXTENSION_HOST"),
        id = value("AWO_EXTENSION_ID"),
        revision = value("AWO_EXTENSION_REVISION"),
        memory = value("AWO_EXTENSION_MAX_MEMORY_MB"),
        cpu = value("AWO_EXTENSION_MAX_CPU_MS"),
        startup = value("AWO_EXTENSION_MAX_STARTUP_MS"),
    )
}
