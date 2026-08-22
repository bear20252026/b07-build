//! AI Work OS desktop shell.
//!
//! The WebView receives no filesystem, shell, database, environment, updater, deep-link, or
//! native-helper API. The sole process bridge starts the fixed bundled Gateway. The small set of
//! Companion commands can only create, restore, or destroy the fixed local desktop window.

use std::{
    fs::create_dir_all,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const GATEWAY_ADDRESS: &str = "127.0.0.1:4318";
const GATEWAY_SIDECAR: &str = "awo-runtime-gateway";
const HEALTH_ATTEMPTS: u8 = 20;
const HEALTH_DELAY: Duration = Duration::from_millis(100);
const MAIN_WINDOW_LABEL: &str = "main";
const DESKTOP_COMPANION_WINDOW_LABEL: &str = "desktop-companion";

struct GatewayLaunchState(Mutex<Option<CommandChild>>);
struct WorkspaceDirectoryState(Mutex<Option<PathBuf>>);

#[derive(serde::Serialize)]
struct WorkspaceDirectorySelection {
    selected: bool,
    label: &'static str,
}

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

/// Opens the system folder picker only after an explicit user action. The selected path remains
/// in native memory; the WebView receives only a non-sensitive label and cannot browse the path.
#[tauri::command]
fn choose_workspace_directory(
    app: AppHandle,
    state: State<'_, WorkspaceDirectoryState>,
) -> Result<WorkspaceDirectorySelection, &'static str> {
    let Some(directory) = app.dialog().file().blocking_pick_folder() else {
        return Ok(WorkspaceDirectorySelection {
            selected: false,
            label: "未选择工作区",
        });
    };
    let path = directory
        .into_path()
        .map_err(|_| "workspace-directory-unavailable")?;
    let mut selected = state
        .0
        .lock()
        .map_err(|_| "workspace-directory-unavailable")?;
    *selected = Some(path);
    Ok(WorkspaceDirectorySelection {
        selected: true,
        label: "已选择本地工作区",
    })
}

/// Creates only the fixed, local Companion surface and hides the main workbench after success.
/// It neither starts a model/Gateway nor grants the new WebView Shell, file, capture, or autostart access.
#[tauri::command]
fn show_desktop_companion(app: AppHandle) -> Result<(), &'static str> {
    if let Some(window) = app.get_webview_window(DESKTOP_COMPANION_WINDOW_LABEL) {
        window.show().map_err(|_| "desktop-companion-unavailable")?;
        window
            .set_focus()
            .map_err(|_| "desktop-companion-unavailable")?;
    } else {
        WebviewWindowBuilder::new(
            &app,
            DESKTOP_COMPANION_WINDOW_LABEL,
            WebviewUrl::App("index.html".into()),
        )
        .title("AI Work OS · Orbit")
        .inner_size(278.0, 330.0)
        .min_inner_size(220.0, 260.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|_| "desktop-companion-unavailable")?;
    }

    let main_window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or("desktop configuration must define the main window")?;
    main_window
        .hide()
        .map_err(|_| "desktop-companion-unavailable")?;
    Ok(())
}

/// Destroys only the fixed Companion window and returns to the main workbench.
#[tauri::command]
fn close_desktop_companion(app: AppHandle) -> Result<(), &'static str> {
    if let Some(window) = app.get_webview_window(DESKTOP_COMPANION_WINDOW_LABEL) {
        window
            .close()
            .map_err(|_| "desktop-companion-unavailable")?;
    }
    let main_window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or("desktop configuration must define the main window")?;
    main_window
        .show()
        .map_err(|_| "desktop-companion-unavailable")?;
    main_window
        .set_focus()
        .map_err(|_| "desktop-companion-unavailable")?;
    Ok(())
}

/// The only full-exit path exposed by the desktop Companion surface.
#[tauri::command]
fn exit_ai_work_os(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(GatewayLaunchState(Mutex::new(None)))
        .manage(WorkspaceDirectoryState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            start_local_gateway,
            choose_workspace_directory,
            show_desktop_companion,
            close_desktop_companion,
            exit_ai_work_os
        ])
        .setup(|app| {
            let main_window = app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .ok_or("desktop configuration must define the main window")?;
            main_window.set_focus()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window
                    .app_handle()
                    .get_webview_window(DESKTOP_COMPANION_WINDOW_LABEL)
                    .is_some()
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("AI Work OS desktop shell failed to run");
}
