use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{sleep, Duration},
};

type SharedChild = Arc<Mutex<Child>>;
type RunMap = Arc<Mutex<HashMap<String, SharedChild>>>;

pub struct TerminalRunState(pub RunMap);

impl TerminalRunState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTerminalCommandRequest {
    pub run_id: String,
    pub command: String,
    pub confirm_dangerous: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTerminalCommandRequest {
    pub run_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResponse {
    pub run_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    run_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDoneEvent {
    run_id: String,
    exit_code: Option<i32>,
    cancelled: bool,
    error: Option<String>,
}

fn valid_run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn requires_confirmation(command: &str) -> bool {
    let value = command.to_ascii_lowercase();
    [
        "rm -rf",
        "remove-item",
        "del /",
        "rmdir /",
        "format ",
        "diskpart",
        "shutdown",
        "restart-computer",
        "stop-computer",
        "reg delete",
        "git push --force",
        "runas",
        "start-process -verb runas",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn command_for(command: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut process = Command::new("cmd");
        process.args(["/C", command]);
        process
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        process
    }
}

async fn relay_lines<R>(app: AppHandle, run_id: String, stream: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => return,
            Ok(_) => {
                let _ = app.emit(
                    "terminal-command-output",
                    TerminalOutputEvent {
                        run_id: run_id.clone(),
                        stream,
                        text: line.clone(),
                    },
                );
            }
            Err(_) => return,
        }
    }
}

#[tauri::command]
pub async fn start_terminal_command(
    app: AppHandle,
    state: State<'_, TerminalRunState>,
    request: StartTerminalCommandRequest,
) -> Result<TerminalStartResponse, &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("terminal-run-id-invalid");
    }
    let command = request.command.trim();
    if command.is_empty() || command.len() > 16_000 {
        return Err("terminal-command-invalid");
    }
    if requires_confirmation(command) && !request.confirm_dangerous {
        return Err("terminal-command-confirmation-required");
    }
    if state.0.lock().await.contains_key(&request.run_id) {
        return Err("terminal-run-already-active");
    }
    let mut process = command_for(command);
    process
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = process
        .spawn()
        .map_err(|_| "terminal-command-spawn-failed")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("terminal-command-output-unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("terminal-command-output-unavailable")?;
    let run_id = request.run_id.clone();
    let child = Arc::new(Mutex::new(child));
    state.0.lock().await.insert(run_id.clone(), child.clone());
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stdout", stdout));
    tauri::async_runtime::spawn(relay_lines(app.clone(), run_id.clone(), "stderr", stderr));
    let runs = state.0.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = {
                let mut process = child.lock().await;
                process.try_wait()
            };
            match status {
                Ok(Some(status)) => {
                    runs.lock().await.remove(&run_id);
                    let _ = app.emit(
                        "terminal-command-done",
                        TerminalDoneEvent {
                            run_id,
                            exit_code: status.code(),
                            cancelled: false,
                            error: None,
                        },
                    );
                    return;
                }
                Ok(None) => sleep(Duration::from_millis(120)).await,
                Err(_) => {
                    runs.lock().await.remove(&run_id);
                    let _ = app.emit(
                        "terminal-command-done",
                        TerminalDoneEvent {
                            run_id,
                            exit_code: None,
                            cancelled: false,
                            error: Some("terminal-command-status-failed".to_owned()),
                        },
                    );
                    return;
                }
            }
        }
    });
    Ok(TerminalStartResponse {
        run_id: request.run_id,
    })
}

#[tauri::command]
pub async fn cancel_terminal_command(
    app: AppHandle,
    state: State<'_, TerminalRunState>,
    request: CancelTerminalCommandRequest,
) -> Result<(), &'static str> {
    if !valid_run_id(&request.run_id) {
        return Err("terminal-run-id-invalid");
    }
    let child = state
        .0
        .lock()
        .await
        .get(&request.run_id)
        .cloned()
        .ok_or("terminal-run-not-found")?;
    let result = child.lock().await.start_kill();
    if result.is_err() {
        return Err("terminal-command-cancel-failed");
    }
    let _ = app.emit(
        "terminal-command-done",
        TerminalDoneEvent {
            run_id: request.run_id,
            exit_code: None,
            cancelled: true,
            error: None,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{requires_confirmation, valid_run_id};
    #[test]
    fn requires_final_confirmation_only_for_high_impact_command_patterns() {
        assert!(!requires_confirmation("npm test"));
        assert!(requires_confirmation("Remove-Item -Recurse C:\\tmp"));
        assert!(requires_confirmation("git push --force"));
    }
    #[test]
    fn validates_run_identifiers() {
        assert!(valid_run_id("run-123"));
        assert!(!valid_run_id("bad id"));
    }
}
