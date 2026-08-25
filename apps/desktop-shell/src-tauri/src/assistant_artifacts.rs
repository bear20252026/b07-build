use crate::WorkspaceDirectoryState;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const APP_ARTIFACT_DIRECTORY: &str = "assistant-artifacts";
const WORKSPACE_ARTIFACT_DIRECTORY: &str = ".ai-work-os/artifacts";
const REPLY_DIRECTORY: &str = "assistant-replies";
const MAX_ARTIFACT_BYTES: usize = 512_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantArtifactReceipt {
    pub logical_path: String,
    pub display_name: String,
    pub byte_size: usize,
    pub created_at: u64,
    pub target: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantArtifactPreview {
    pub logical_path: String,
    pub display_name: String,
    pub content: String,
    pub byte_size: usize,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantArtifactExportReceipt {
    pub exported: bool,
    pub display_name: String,
    pub byte_size: usize,
}

fn validate_file_name(file_name: &str) -> Result<(), &'static str> {
    if file_name.len() < 4 || file_name.len() > 80 || !file_name.ends_with(".md") {
        return Err("assistant-artifact-file-name-invalid");
    }
    if !file_name
        .as_bytes()
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("assistant-artifact-file-name-invalid");
    }
    Ok(())
}

fn root_for_target(
    app: &AppHandle,
    workspace: &State<'_, WorkspaceDirectoryState>,
    target: &str,
) -> Result<(PathBuf, &'static str), &'static str> {
    match target {
        "app-managed" => Ok((
            app.path()
                .app_data_dir()
                .map_err(|_| "assistant-artifact-app-directory-unavailable")?
                .join(APP_ARTIFACT_DIRECTORY),
            "app-managed",
        )),
        "selected-workspace" => {
            let selected = workspace
                .0
                .lock()
                .map_err(|_| "assistant-artifact-workspace-unavailable")?
                .clone()
                .ok_or("assistant-artifact-workspace-not-selected")?;
            Ok((
                selected.join(WORKSPACE_ARTIFACT_DIRECTORY),
                "selected-workspace",
            ))
        }
        _ => Err("assistant-artifact-target-invalid"),
    }
}

fn artifact_path(root: &Path, logical_path: &str) -> Result<(PathBuf, String), &'static str> {
    let Some(file_name) = logical_path.strip_prefix("assistant-replies/") else {
        return Err("assistant-artifact-logical-path-invalid");
    };
    validate_file_name(file_name)?;
    Ok((
        root.join(REPLY_DIRECTORY).join(file_name),
        file_name.to_string(),
    ))
}

fn validate_export_destination(path: &Path) -> Result<String, &'static str> {
    if !path.is_absolute() {
        return Err("assistant-artifact-export-destination-invalid");
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("assistant-artifact-export-destination-invalid")?;
    validate_file_name(file_name)?;
    Ok(file_name.to_string())
}

fn bounded_preview(content: &str) -> (String, bool) {
    if content.len() <= MAX_ARTIFACT_BYTES {
        return (content.to_string(), false);
    }
    let boundary = content
        .char_indices()
        .take_while(|(index, _)| *index <= MAX_ARTIFACT_BYTES)
        .last()
        .map(|(index, _)| index)
        .unwrap_or(0);
    (content[..boundary].to_string(), true)
}

#[tauri::command]
pub fn save_assistant_markdown_artifact(
    app: AppHandle,
    workspace: State<'_, WorkspaceDirectoryState>,
    target: String,
    file_name: String,
    content: String,
) -> Result<AssistantArtifactReceipt, &'static str> {
    validate_file_name(&file_name)?;
    if content.trim().is_empty() || content.len() > MAX_ARTIFACT_BYTES {
        return Err("assistant-artifact-content-invalid");
    }
    let (root, target_label) = root_for_target(&app, &workspace, &target)?;
    let logical_path = format!("assistant-replies/{file_name}");
    let (path, _) = artifact_path(&root, &logical_path)?;
    if path.exists() {
        return Err("assistant-artifact-already-exists");
    }
    let parent = path
        .parent()
        .ok_or("assistant-artifact-directory-unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "assistant-artifact-directory-unavailable")?;
    let temp = parent.join(format!(".{file_name}.pending"));
    fs::write(&temp, content.as_bytes()).map_err(|_| "assistant-artifact-write-failed")?;
    fs::rename(&temp, &path).map_err(|_| {
        let _ = fs::remove_file(&temp);
        "assistant-artifact-write-failed"
    })?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "assistant-artifact-clock-unavailable")?
        .as_millis() as u64;
    Ok(AssistantArtifactReceipt {
        logical_path,
        display_name: file_name,
        byte_size: content.len(),
        created_at,
        target: target_label,
    })
}

#[tauri::command]
pub fn read_assistant_markdown_artifact(
    app: AppHandle,
    workspace: State<'_, WorkspaceDirectoryState>,
    target: String,
    logical_path: String,
) -> Result<AssistantArtifactPreview, &'static str> {
    let (root, _) = root_for_target(&app, &workspace, &target)?;
    let (path, display_name) = artifact_path(&root, &logical_path)?;
    let content = fs::read_to_string(path).map_err(|_| "assistant-artifact-read-failed")?;
    let byte_size = content.len();
    let (preview, truncated) = bounded_preview(&content);
    Ok(AssistantArtifactPreview {
        logical_path,
        display_name,
        byte_size,
        content: preview,
        truncated,
    })
}

/// Exports exactly one already-confirmed Markdown artifact after an explicit user click. The
/// native Save As dialog selects the destination, while the WebView receives no destination path.
#[tauri::command]
pub fn export_assistant_markdown_artifact(
    app: AppHandle,
    workspace: State<'_, WorkspaceDirectoryState>,
    target: String,
    logical_path: String,
) -> Result<AssistantArtifactExportReceipt, &'static str> {
    let (root, _) = root_for_target(&app, &workspace, &target)?;
    let (source, display_name) = artifact_path(&root, &logical_path)?;
    let content = fs::read(&source).map_err(|_| "assistant-artifact-read-failed")?;
    if content.is_empty() || content.len() > MAX_ARTIFACT_BYTES {
        return Err("assistant-artifact-content-invalid");
    }
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("导出已保存的 Markdown 回复")
        .set_file_name(&display_name)
        .add_filter("Markdown", &["md"])
        .blocking_save_file()
    else {
        return Ok(AssistantArtifactExportReceipt {
            exported: false,
            display_name,
            byte_size: content.len(),
        });
    };
    let destination = selected
        .into_path()
        .map_err(|_| "assistant-artifact-export-destination-invalid")?;
    validate_export_destination(&destination)?;
    if destination == source {
        return Err("assistant-artifact-export-destination-invalid");
    }
    fs::write(destination, &content).map_err(|_| "assistant-artifact-export-write-failed")?;
    Ok(AssistantArtifactExportReceipt {
        exported: true,
        display_name,
        byte_size: content.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::{validate_export_destination, validate_file_name};
    use std::path::Path;

    #[test]
    fn accepts_only_bounded_markdown_leaf_names() {
        assert!(validate_file_name("ai-reply-20260824.md").is_ok());
        assert!(validate_file_name("../outside.md").is_err());
        assert!(validate_file_name("reply.txt").is_err());
    }

    #[test]
    fn export_destination_keeps_an_absolute_bounded_markdown_leaf() {
        let absolute = std::env::temp_dir().join("exported-reply.md");
        assert!(validate_export_destination(&absolute).is_ok());
        assert!(validate_export_destination(Path::new("relative.md")).is_err());
        assert!(
            validate_export_destination(&std::env::temp_dir().join("exported-reply.txt")).is_err()
        );
    }
}
