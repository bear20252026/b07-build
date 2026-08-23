//! AI Work OS desktop shell.
//!
//! The WebView receives no filesystem, shell, database, environment, updater, deep-link, or
//! native-helper API. Third-party model requests are issued by the fixed native Provider client
//! from explicit user configuration; Companion commands only create, restore, or destroy the fixed local desktop window.

#[cfg(not(mobile))]
mod direct_provider;
#[cfg(not(mobile))]
mod web_search;
#[cfg(not(mobile))]
mod terminal;
#[cfg(not(mobile))]
mod file_extract;

#[cfg(not(mobile))]
use std::{
    path::PathBuf,
    sync::Mutex,
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
#[cfg(not(mobile))]
use tauri::{State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(mobile))]
use tauri_plugin_dialog::DialogExt;
#[cfg(not(mobile))]

#[cfg(not(mobile))]
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(not(mobile))]
const DESKTOP_COMPANION_WINDOW_LABEL: &str = "desktop-companion";

#[cfg(not(mobile))]
struct WorkspaceDirectoryState(Mutex<Option<PathBuf>>);

#[cfg(not(mobile))]
#[derive(serde::Serialize)]
struct WorkspaceDirectorySelection {
    selected: bool,
    label: &'static str,
}

/// Opens the system folder picker only after an explicit user action. The selected path remains
/// in native memory; the WebView receives only a non-sensitive label and cannot browse the path.
#[cfg(not(mobile))]
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
#[cfg(not(mobile))]
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
#[cfg(not(mobile))]
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

/// Keeps the application discoverable after the main window is minimized or hidden by the Companion surface.
#[cfg(not(mobile))]
fn install_desktop_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_workbench = MenuItem::with_id(app, "tray-show-workbench", "打开工作台", true, None::<&str>)?;
    let show_companion = MenuItem::with_id(app, "tray-show-companion", "显示桌面助手", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "tray-exit", "退出 AI Work OS", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_workbench, &show_companion, &exit])?;
    let mut builder = TrayIconBuilder::with_id("ai-work-os-tray")
        .tooltip("AI Work OS · 直接模型连接")
        .menu(&menu);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "tray-show-workbench" => { let _ = close_desktop_companion(app.clone()); }
            "tray-show-companion" => { let _ = show_desktop_companion(app.clone()); }
            "tray-exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// The only full-exit path exposed by the desktop Companion surface.
#[tauri::command]
fn exit_ai_work_os(app: AppHandle) {
    app.exit(0);
}

#[cfg(not(mobile))]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(direct_provider::DirectProviderState::new())
        .manage(terminal::TerminalRunState::new())
        .manage(WorkspaceDirectoryState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            direct_provider::configure_direct_provider,
            direct_provider::discover_direct_provider,
            direct_provider::probe_direct_provider,
            direct_provider::start_direct_provider_stream,
            web_search::search_web,
            terminal::start_terminal_command,
            terminal::cancel_terminal_command,
            file_extract::extract_file_content,
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
            install_desktop_tray(app.handle())?;
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

/// Android/iOS 不继承 Windows sidecar、目录选择或桌面 Companion 命令。
/// 移动端只承载经过平台配置隔离的 Web 工作台；远程模型接入仍需后续明确的数据出境确认。
#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![exit_ai_work_os])
        .setup(|app| {
            let main_window = app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .ok_or("mobile configuration must define the main window")?;
            main_window.set_focus()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("AI Work OS mobile shell failed to run");
}
