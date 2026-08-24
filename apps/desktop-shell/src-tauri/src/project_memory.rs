use crate::WorkspaceDirectoryState;
use serde::Serialize;
use std::{fs, io::ErrorKind, path::PathBuf};
use tauri::State;

const PROJECT_MEMORY_FILE: &str = "AI_WORK_OS_MEMORY.md";
const MAX_MEMORY_BYTES: usize = 256_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemorySnapshot {
    pub selected: bool,
    pub file_name: &'static str,
    pub content: String,
}

fn memory_path(
    state: &State<'_, WorkspaceDirectoryState>,
) -> Result<Option<PathBuf>, &'static str> {
    let workspace = state
        .0
        .lock()
        .map_err(|_| "project-memory-workspace-unavailable")?;
    Ok(workspace
        .as_ref()
        .map(|directory| directory.join(PROJECT_MEMORY_FILE)))
}

#[tauri::command]
pub fn read_project_memory(
    state: State<'_, WorkspaceDirectoryState>,
) -> Result<ProjectMemorySnapshot, &'static str> {
    let Some(path) = memory_path(&state)? else {
        return Ok(ProjectMemorySnapshot {
            selected: false,
            file_name: PROJECT_MEMORY_FILE,
            content: String::new(),
        });
    };
    let content = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(_) => return Err("project-memory-read-failed"),
    };
    if content.len() > MAX_MEMORY_BYTES {
        return Err("project-memory-too-large");
    }
    Ok(ProjectMemorySnapshot {
        selected: true,
        file_name: PROJECT_MEMORY_FILE,
        content,
    })
}

#[tauri::command]
pub fn write_project_memory(
    state: State<'_, WorkspaceDirectoryState>,
    content: String,
) -> Result<ProjectMemorySnapshot, &'static str> {
    if content.len() > MAX_MEMORY_BYTES {
        return Err("project-memory-too-large");
    }
    let Some(path) = memory_path(&state)? else {
        return Err("project-memory-workspace-not-selected");
    };
    fs::write(&path, content).map_err(|_| "project-memory-write-failed")?;
    read_project_memory(state)
}
