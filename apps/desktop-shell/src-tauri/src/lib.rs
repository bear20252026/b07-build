//! AI Work OS desktop shell.
//!
//! The WebView receives no filesystem, shell, database, environment, updater, deep-link, or
//! native-helper API. The sole privileged bridge is an explicit, fixed Gateway start request.
//! It can only run the bundled `awo-runtime-gateway` sidecar in its fixed `serve` mode.

use std::{
    fs::create_dir_all,
    net::{SocketAddr, TcpStream},
    sync::Mutex,
    time::Duration,
};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const GATEWAY_ADDRESS: &str = "127.0.0.1:4318";
const GATEWAY_SIDECAR: &str = "awo-runtime-gateway";
const HEALTH_ATTEMPTS: u8 = 20;
const HEALTH_DELAY: Duration = Duration::from_millis(100);

struct GatewayLaunchState(Mutex<Option<CommandChild>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum GatewayStartOutcome {
    Started,
    AlreadyRunning,
}

/// 为 sidecar 建立唯一的、每用户私有的数据工作目录；该路径不返回给 WebView。
fn gateway_data_directory(app: &AppHandle) -> Result<std::path::PathBuf, &'static str> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "gateway-data-directory-unavailable")?;
    // Gateway composition root 将其持久化文件统一置于相对 `.awo/`；只预建该固定子目录。
    create_dir_all(directory.join(".awo")).map_err(|_| "gateway-data-directory-unavailable")?;
    Ok(directory)
}

fn gateway_is_reachable() -> bool {
    let Ok(address) = GATEWAY_ADDRESS.parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(75)).is_ok()
}

/// Starts only the audited bundled Gateway sidecar in its fixed `serve` mode.
/// No path, port, environment, command, or other process argument is caller-controlled.
#[tauri::command]
fn start_local_gateway(
    app: AppHandle,
    state: State<'_, GatewayLaunchState>,
) -> Result<GatewayStartOutcome, &'static str> {
    if gateway_is_reachable() {
        return Ok(GatewayStartOutcome::AlreadyRunning);
    }

    let data_directory = gateway_data_directory(&app)?;
    let command = app
        .shell()
        .sidecar(GATEWAY_SIDECAR)
        .map_err(|_| "gateway-sidecar-unavailable")
        .and_then(|command| {
            command
                .current_dir(data_directory)
                .args(["serve"])
                .spawn()
                .map_err(|_| "gateway-sidecar-unavailable")
        })?;
    let (_events, child) = command;

    for _ in 0..HEALTH_ATTEMPTS {
        std::thread::sleep(HEALTH_DELAY);
        if gateway_is_reachable() {
            let mut stored_child = state
                .0
                .lock()
                .map_err(|_| "gateway-launch-state-unavailable")?;
            *stored_child = Some(child);
            return Ok(GatewayStartOutcome::Started);
        }
    }

    child.kill().map_err(|_| "gateway-sidecar-stop-failed")?;
    Err("gateway-sidecar-unavailable")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(GatewayLaunchState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_local_gateway])
        .setup(|app| {
            let main_window = app
                .get_webview_window("main")
                .ok_or("desktop configuration must define the main window")?;
            main_window.set_focus()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("AI Work OS desktop shell failed to run");
}
