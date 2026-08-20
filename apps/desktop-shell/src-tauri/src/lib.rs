//! AI Work OS desktop shell.
//!
//! This crate is intentionally a presentation host only. It has no Tauri `invoke` commands,
//! no filesystem, shell, sidecar, autostart, updater, deep-link, or native-helper integration.
//! The WebView receives no privileged desktop API. Gateway and native-host attachment remain
//! explicit, independently governed workflows outside this initial desktop shell.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
