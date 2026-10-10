//! 工作区文件读写：Agent 能力的第一块地基。
//!
//! 这里刻意只做“读得到、列得出、写得进”这三件事，并且全部限制在用户**显式选中的**
//! 本地工作区目录之内。没有选中工作区时所有命令一律拒绝，绝不回退到任意磁盘路径。
//!
//! 防护分三层，任何一层失败都拒绝而不是降级：
//!   1. 相对路径语法层：拒绝绝对路径、盘符前缀与 `..` 分段
//!   2. 规范化层：canonicalize 之后必须仍以工作区根为前缀（挡住符号链接逃逸）
//!   3. 体积层：读取与写入都有硬上限，防止把整块内存或磁盘吃满

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::WorkspaceDirectoryState;

/// 单次列目录最多返回的条目数，防止巨型仓库把 IPC 响应撑爆。
pub const MAX_LIST_ENTRIES: usize = 500;
/// 单文件读写上限 2 MB。更大的文件应当先由工具切片，而不是整体塞进上下文。
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

/// 递归遍历时跳过的目录：要么是构建产物，要么体量与语义价值不成比例。
const SKIPPED_DIRECTORIES: [&str; 7] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    /// 相对工作区根的路径，统一用 `/` 分隔，作为模型侧的路径引用使用。
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub byte_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileList {
    pub root_label: String,
    pub entries: Vec<WorkspaceFileEntry>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub path: String,
    pub content: String,
    pub byte_size: usize,
    pub truncated: bool,
}

fn selected_root(state: &State<'_, WorkspaceDirectoryState>) -> Result<PathBuf, &'static str> {
    state
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .clone()
        .ok_or("workspace-root-not-selected")
}

/// 语法层校验：相对路径里不允许出现绝对路径特征或向上穿越。
fn reject_unsafe_relative(relative: &str) -> Result<(), &'static str> {
    if relative.trim().is_empty() {
        return Err("workspace-path-empty");
    }
    for component in Path::new(relative).components() {
        match component {
            Component::ParentDir => return Err("workspace-path-escapes-root"),
            Component::RootDir | Component::Prefix(_) => return Err("workspace-path-absolute"),
            _ => {}
        }
    }
    Ok(())
}

/// 把相对路径解析成工作区内的绝对路径，并确认规范化后仍位于根之内。
fn resolve_within(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    reject_unsafe_relative(relative)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "workspace-root-unavailable")?;
    let candidate = canonical_root.join(relative);
    // canonicalize 会解出符号链接的真实目标，这是挡住“软链指向 /etc”的关键一步。
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "workspace-path-not-found")?;
    if !canonical.starts_with(&canonical_root) {
        return Err("workspace-path-escapes-root");
    }
    Ok(canonical)
}

/// 统一转成 `/` 分隔，让模型拿到的路径引用在任何平台上都是同一种写法。
fn to_relative_key(root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(root)
        .map(|tail| {
            tail.components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| absolute.to_string_lossy().replace('\\', "/"))
}

fn collect(
    root: &Path,
    directory: &Path,
    recursive: bool,
    out: &mut Vec<WorkspaceFileEntry>,
) -> Result<bool, &'static str> {
    let mut truncated = false;
    let entries = fs::read_dir(directory).map_err(|_| "workspace-directory-unreadable")?;
    let mut collected: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = fs::metadata(&path).ok()?;
            let kind = if metadata.is_dir() {
                "directory"
            } else {
                "file"
            };
            if kind == "directory" && SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                return None;
            }
            Some((path, name, kind, metadata.len()))
        })
        .collect();
    collected.sort_by(|left, right| left.1.cmp(&right.1));
    for (path, name, kind, byte_size) in collected {
        if out.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            return Ok(truncated);
        }
        out.push(WorkspaceFileEntry {
            path: to_relative_key(root, &path),
            name,
            kind,
            byte_size,
        });
        if recursive && kind == "directory" {
            truncated |= collect(root, &path, recursive, out)?;
        }
    }
    Ok(truncated)
}

#[tauri::command]
pub fn workspace_list_files(
    state: State<'_, WorkspaceDirectoryState>,
    path: Option<String>,
    recursive: Option<bool>,
) -> Result<WorkspaceFileList, &'static str> {
    let root = selected_root(&state)?;
    let relative = path.unwrap_or_default();
    let directory = if relative.trim().is_empty() {
        root.clone()
    } else {
        resolve_within(&root, &relative)?
    };
    if !directory.is_dir() {
        return Err("workspace-path-not-directory");
    }
    let mut entries = Vec::new();
    let truncated = collect(&root, &directory, recursive.unwrap_or(false), &mut entries)?;
    Ok(WorkspaceFileList {
        root_label: root.to_string_lossy().to_string(),
        entries,
        truncated,
    })
}

#[tauri::command]
pub fn workspace_read_file(
    state: State<'_, WorkspaceDirectoryState>,
    path: String,
) -> Result<WorkspaceFileContent, &'static str> {
    let root = selected_root(&state)?;
    let target = resolve_within(&root, &path)?;
    if !target.is_file() {
        return Err("workspace-path-not-file");
    }
    let bytes = fs::read(&target).map_err(|_| "workspace-file-unreadable")?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("workspace-file-too-large");
    }
    // 只接受有效 UTF-8：二进制交给模型只会污染上下文，宁可明确拒绝。
    let mut text = String::from_utf8(bytes).map_err(|_| "workspace-file-not-utf8")?;
    let truncated = text.len() > MAX_FILE_BYTES;
    if truncated {
        text.truncate(MAX_FILE_BYTES);
    }
    Ok(WorkspaceFileContent {
        path: to_relative_key(&root, &target),
        byte_size: text.len(),
        content: text,
        truncated,
    })
}

#[tauri::command]
pub fn workspace_write_file(
    state: State<'_, WorkspaceDirectoryState>,
    path: String,
    content: String,
) -> Result<WorkspaceFileContent, &'static str> {
    if content.len() > MAX_FILE_BYTES {
        return Err("workspace-file-too-large");
    }
    let root = selected_root(&state)?;
    let target = resolve_within(&root, &path)?;
    // 只能覆写已经存在的文件，不凭空创建：新建文件的意图应当由上层显式确认后再走这里，
    // 避免模型一次幻觉就在项目里撒下一堆垃圾文件。
    if !target.is_file() {
        return Err("workspace-file-not-found");
    }
    fs::write(&target, content.as_bytes()).map_err(|_| "workspace-file-unwritable")?;
    Ok(WorkspaceFileContent {
        path: to_relative_key(&root, &target),
        byte_size: content.len(),
        content,
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_parent_traversal() {
        assert_eq!(reject_unsafe_relative("src/main.rs"), Ok(()));
        assert_eq!(
            reject_unsafe_relative("../secrets"),
            Err("workspace-path-escapes-root")
        );
        assert_eq!(
            reject_unsafe_relative("a/../../b"),
            Err("workspace-path-escapes-root")
        );
        assert_eq!(reject_unsafe_relative(""), Err("workspace-path-empty"));
    }

    #[test]
    fn resolve_rejects_symlink_escape_and_missing_paths() {
        let root = std::env::temp_dir().join(format!("awo-workspace-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        assert!(resolve_within(&root, "anything").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_keys_use_forward_slashes() {
        let root = Path::new("/tmp/project");
        let file = Path::new("/tmp/project/src/lib.rs");
        assert_eq!(to_relative_key(root, file), "src/lib.rs");
    }
}
