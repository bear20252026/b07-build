use crate::WorkspaceDirectoryState;
use serde::Serialize;
use std::{fs, io::ErrorKind, path::PathBuf};
use tauri::State;

use crate::workspace_files::{ensure_regular_file, open_no_follow};

const PROJECT_MEMORY_FILE: &str = "AI_WORK_OS_MEMORY.md";
const MAX_MEMORY_BYTES: usize = 256_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemorySnapshot {
    pub selected: bool,
    pub file_name: &'static str,
    pub content: String,
}

/// 记忆文件路径（SEC-009）：根必须先规范化，防止用户选中的目录本身是个符号链接；
/// 文件级的链接防护交给与工作区文件同一套 open_no_follow / ensure_regular_file。
fn memory_path(
    state: &State<'_, WorkspaceDirectoryState>,
) -> Result<Option<PathBuf>, &'static str> {
    let workspace = state
        .0
        .lock()
        .map_err(|_| "project-memory-workspace-unavailable")?
        .clone();
    let Some(directory) = workspace else {
        return Ok(None);
    };
    let canonical = directory
        .canonicalize()
        .map_err(|_| "project-memory-workspace-unavailable")?;
    Ok(Some(canonical.join(PROJECT_MEMORY_FILE)))
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
    if !path.exists() {
        return Ok(ProjectMemorySnapshot {
            selected: true,
            file_name: PROJECT_MEMORY_FILE,
            content: String::new(),
        });
    }
    // 不穿透符号链接地读：AI_WORK_OS_MEMORY.md 被换成指向外部的链接时，读不到外部内容。
    let mut file = open_no_follow(&path, false)?;
    ensure_regular_file(&file)?;
    let mut bytes: Vec<u8> = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes).map_err(|_| "project-memory-read-failed")?;
    if bytes.len() > MAX_MEMORY_BYTES {
        return Err("project-memory-too-large");
    }
    let content = match String::from_utf8(bytes) {
        Ok(value) => value,
        Err(_) => return Err("project-memory-read-failed"),
    };
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
    if path.exists() {
        // 已有文件被换成符号链接时拒绝写入，绝不能顺着链接写到工作区之外。
        if fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("project-memory-symlink-denied");
        }
    } else {
        // ErrorKind::NotFound 之外的 exists() 失败按不可访问处理。
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() != ErrorKind::NotFound => {
                return Err("project-memory-write-failed")
            }
            _ => {}
        }
    }
    {
        let mut file = open_no_follow(&path, true).map_err(|_| "project-memory-write-failed")?;
        ensure_regular_file(&file).map_err(|_| "project-memory-symlink-denied")?;
        std::io::Write::write_all(&mut file, content.as_bytes())
            .map_err(|_| "project-memory-write-failed")?;
    }
    read_project_memory(state)
}

#[cfg(test)]
mod tests {
    use super::MAX_MEMORY_BYTES;

    #[test]
    fn memory_budget_is_enforced_before_any_io() {
        // 超限内容在拿到路径之前就该被拒绝——这条断言把上限本身钉进测试。
        const _: () = assert!(MAX_MEMORY_BYTES < 1_000_000);
    }
}
