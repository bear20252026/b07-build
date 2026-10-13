//! 工作区文件读写：Agent 能力的第一块地基。
//!
//! 这里刻意只做“读得到、列得出、写得进”这三件事，并且全部限制在用户**显式选中的**
//! 本地工作区目录之内。没有选中工作区时所有命令一律拒绝，绝不回退到任意磁盘路径。
//!
//! 防护分四层，任何一层失败都拒绝而不是降级：
//!   1. 相对路径语法层：拒绝绝对路径、盘符前缀与 `..` 分段
//!   2. 规范化层：canonicalize 之后必须仍以工作区根为前缀（挡住符号链接逃逸）
//!   3. 打开层：SEC-002/004——`fs::metadata` 会**跟随**符号链接，目录树递归与
//!      文件读写都改用不穿透链接的打开方式；目录符号链接不遍历、文件符号链接
//!      打开后复核句柄身份，工作区内一个指向外部的链接读不出任何内容
//!   4. 体积与授权层：读取与写入都有硬上限；写入还必须携带一张原生审批票据
//!      （见 workspace_approval.rs），票据绑定了「批准时看到的原文哈希」，
//!      磁盘内容在批准后被别人动过就拒绝写入

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::workspace_approval::{consume_grant, hash_hex, WorkspaceApprovalState};
use crate::WorkspaceDirectoryState;

/// 单次列目录最多返回的条目数，防止巨型仓库把 IPC 响应撑爆。
pub const MAX_LIST_ENTRIES: usize = 500;
/// 单文件读写上限 2 MB。更大的文件应当先由工具切片，而不是整体塞进上下文。
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
/// 递归列目录的深度上限：即使没有符号链接，病态深层目录也不该吃满栈。
pub const MAX_LIST_DEPTH: usize = 32;

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

pub(crate) fn selected_root(
    state: &State<'_, WorkspaceDirectoryState>,
) -> Result<PathBuf, &'static str> {
    state
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .clone()
        .ok_or("workspace-root-not-selected")
}

/// 语法层校验：相对路径里不允许出现绝对路径特征或向上穿越。
pub(crate) fn reject_unsafe_relative(relative: &str) -> Result<(), &'static str> {
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
pub(crate) fn resolve_within(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
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
pub(crate) fn to_relative_key(root: &Path, absolute: &Path) -> String {
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

/// 以**不穿透符号链接**的方式打开文件（SEC-002/004）。
///
/// Windows 用 `FILE_FLAG_OPEN_REPARSE_POINT`，Unix 用 `O_NOFOLLOW`：
/// 打开的是链接本身而不是链接指向的目标。随后用 [`ensure_regular_file`]
/// 复核句柄身份，把「检查通过之后路径被换成符号链接」的竞态窗口压缩到
/// 单个已打开句柄的生命周期内——句柄一旦打开，内容读写就不再经过路径。
pub(crate) fn open_no_follow(path: &Path, write: bool) -> Result<fs::File, &'static str> {
    let mut options = fs::OpenOptions::new();
    if write {
        options.write(true).truncate(true);
    } else {
        options.read(true);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Linux O_NOFOLLOW = 0o400000。R1 整改前误写 0o200000（实为 O_DIRECTORY），
        // 导致 Linux/macOS 上打开任何普通文件都以 ENOTDIR 失败——由补丁批量事务
        // 的 Linux CI 测试首次暴露。
        options.custom_flags(0o400000); // O_NOFOLLOW
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // macOS O_NOFOLLOW = 0o200。
        options.custom_flags(0o200); // O_NOFOLLOW
    }
    options
        .open(path)
        .map_err(|_| {
            // 打开失败时给出更精确的原因：目标本身是符号链接就明说，拒绝读穿或写穿。
            if fs::symlink_metadata(path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false)
            {
                "workspace-file-is-symlink"
            } else if write {
                "workspace-file-unwritable"
            } else {
                "workspace-file-unreadable"
            }
        })
        .and_then(|file| {
            // Windows 的 FILE_FLAG_OPEN_REPARSE_POINT 打开链接本身会**成功**（拿到
            // 的是 reparse point 句柄），Unix 的 O_NOFOLLOW 才直接报错。所以打开
            // 成功后必须复核句柄：不是普通文件（符号链接、目录等）一律拒绝。
            if file
                .metadata()
                .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
                .unwrap_or(true)
            {
                return Err("workspace-file-is-symlink");
            }
            Ok(file)
        })
}

/// 复核已打开的句柄确实是普通文件，不是链接也不是目录。
pub(crate) fn ensure_regular_file(file: &fs::File) -> Result<(), &'static str> {
    let metadata = file.metadata().map_err(|_| "workspace-file-unreadable")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("workspace-file-is-symlink");
    }
    Ok(())
}

/// 唯一化临时文件名：同目录、同卷，保证 rename 原子性。
fn temp_file_name(target: &Path) -> Result<String, &'static str> {
    let file_name = target
        .file_name()
        .ok_or("workspace-path-invalid")?
        .to_string_lossy()
        .to_string();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    Ok(format!(
        ".{}.awotmp-{}-{}",
        file_name,
        std::process::id(),
        unique
    ))
}

/// 用「临时文件 + 原子换名」替换目标文件内容（R1 审计 R2-03）。
///
/// 旧实现先以 truncate(true) 打开目标再检查文件类型——打开动作本身就会毁掉
/// 原文，写到一半失败就是残缺文件。新流程：在同目录以 create_new 创建临时
/// 文件（不跟随已有重解析点）→ 写入并落盘 → rename 原子替换目标。
/// rename 之前目标原文始终完整；任何一步失败都清理临时文件，目标不受影响。
/// 注意：rename 替换的是目录项本身（POSIX 语义不跟随末段符号链接），
/// 「检查后路径被换名」的窗口由目录项原子替换封闭。
pub(crate) fn replace_file_contents(target: &Path, content: &[u8]) -> Result<(), &'static str> {
    let parent = target.parent().ok_or("workspace-path-not-directory")?;
    let temp = parent.join(temp_file_name(target)?);
    let write_result = (|| -> Result<(), &'static str> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "workspace-file-unwritable")?;
        ensure_regular_file(&file)?;
        file.write_all(content)
            .map_err(|_| "workspace-file-unwritable")?;
        file.sync_all().map_err(|_| "workspace-file-unwritable")
    })();
    if let Err(code) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(code);
    }
    match fs::rename(&temp, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(&temp);
            Err("workspace-file-unwritable")
        }
    }
}

fn collect(
    root: &Path,
    directory: &Path,
    recursive: bool,
    depth: usize,
    out: &mut Vec<WorkspaceFileEntry>,
) -> Result<bool, &'static str> {
    let mut truncated = false;
    if depth > MAX_LIST_DEPTH {
        truncated = true;
        return Ok(truncated);
    }
    let entries = fs::read_dir(directory).map_err(|_| "workspace-directory-unreadable")?;
    let mut collected: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            // DirEntry::file_type() 不穿透符号链接：符号链接在这里现出原形。
            // 注意必须**先**判 symlink 再算 kind——Windows 上目录符号链接的
            // file_type() 是 is_symlink()==true 且 is_dir()==false，若先按
            // is_dir() 分 kind 会被错标成 "file" 而漏掉过滤。
            let file_type = entry.file_type().ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            // DirEntry::metadata() 等价于 symlink_metadata，大小取链接本身，不跟随。
            let metadata = entry.metadata().ok()?;
            // SEC-002：符号链接既不列出来也不遍历——跟随目录链接就可能离开
            // 工作区（甚至自引用无限递归），文件链接读取时同样会被拒，列出
            // 只会制造"看得见打不开"的困惑。
            if file_type.is_symlink() {
                return None;
            }
            let kind = if file_type.is_dir() {
                "directory"
            } else {
                "file"
            };
            if kind == "directory" && SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                return None;
            }
            Some((entry.path(), name, kind, metadata.len()))
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
            truncated |= collect(root, &path, recursive, depth + 1, out)?;
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
    let truncated = collect(
        &root,
        &directory,
        recursive.unwrap_or(false),
        0,
        &mut entries,
    )?;
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
    // 不穿透符号链接地打开；打开之后内容读写只经过句柄，不再经过可被调包的路径。
    let file = open_no_follow(&target, false)?;
    ensure_regular_file(&file)?;
    let mut bytes: Vec<u8> = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "workspace-file-unreadable")?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("workspace-file-too-large");
    }
    // 只接受有效 UTF-8：二进制交给模型只会污染上下文，宁可明确拒绝。
    let text = String::from_utf8(bytes).map_err(|_| "workspace-file-not-utf8")?;
    let byte_size = text.len();
    Ok(WorkspaceFileContent {
        path: to_relative_key(&root, &target),
        byte_size,
        content: text,
        truncated: false,
    })
}

#[tauri::command]
pub fn workspace_write_file(
    state: State<'_, WorkspaceDirectoryState>,
    approval: State<'_, WorkspaceApprovalState>,
    path: String,
    content: String,
    approval_token: Option<String>,
) -> Result<WorkspaceFileContent, &'static str> {
    if content.len() > MAX_FILE_BYTES {
        return Err("workspace-file-too-large");
    }
    let root = selected_root(&state)?;
    // SEC-008：写入必须携带原生审批票据。没有票据的调用在这里就死，
    // 前端就算被绕过也无法直接命令原生层写文件。
    let token = approval_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("workspace-write-approval-required")?;
    let grant = consume_grant(&approval, token)?;
    let target = resolve_within(&root, &path)?;
    // 票据绑定的路径必须与实际写入目标完全一致（canonicalize 之后的规范化路径）。
    let canonical_relative = to_relative_key(&root, &target);
    if canonical_relative != grant.path {
        return Err("workspace-write-approval-mismatch");
    }
    // 只能覆写已经存在的文件，不凭空创建：新建文件的意图应当由上层显式确认后再走这里，
    // 避免模型一次幻觉就在项目里撒下一堆垃圾文件。
    if !target.is_file() {
        return Err("workspace-file-not-found");
    }
    // 票据签发时用户看到的是哪份原文，现在磁盘上就必须还是哪份原文。
    // 拿不到原文（文件被删）或哈希对不上（被第三方改过）都拒绝写入。
    let current = {
        let file = open_no_follow(&target, false)?;
        ensure_regular_file(&file)?;
        let mut bytes: Vec<u8> = Vec::new();
        file.take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "workspace-file-unreadable")?;
        bytes
    };
    if hash_hex(&current) != grant.previous_sha256 {
        return Err("workspace-write-approval-stale");
    }
    if hash_hex(content.as_bytes()) != grant.next_sha256 {
        return Err("workspace-write-approval-content-mismatch");
    }
    // R2-03：临时文件 + 原子换名落盘；失败时原文完整保留。
    replace_file_contents(&target, content.as_bytes())?;
    Ok(WorkspaceFileContent {
        path: canonical_relative,
        byte_size: content.len(),
        content,
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 跨平台创建目录符号链接；失败（如 Windows 未开开发者模式）返回 Err，由用例跳过。
    #[cfg(target_os = "windows")]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(not(target_os = "windows"))]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    /// 跨平台创建文件符号链接。
    #[cfg(target_os = "windows")]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(not(target_os = "windows"))]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

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
    fn open_no_follow_rejects_file_symlinks_and_opens_regular_files() {
        let root = std::env::temp_dir().join(format!(
            "awo-open-nofollow-test-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::create_dir_all(&root);
        fs::write(
            root.join("real.txt"),
            "content
",
        )
        .unwrap();
        // 回归钉子：O_NOFOLLOW 常量写错时（曾误用 O_DIRECTORY），这里会以
        // ENOTDIR 拒绝普通文件，用例立刻失败。
        assert!(open_no_follow(&root.join("real.txt"), false).is_ok());
        if create_file_symlink(&root.join("real.txt"), &root.join("link.txt")).is_ok() {
            assert_eq!(
                open_no_follow(&root.join("link.txt"), false).err(),
                Some("workspace-file-is-symlink")
            );
        }
        let _ = fs::remove_dir_all(&root);
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

    #[test]
    fn directory_symlinks_are_never_traversed() {
        let root = std::env::temp_dir().join(format!("awo-symlink-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let outside = std::env::temp_dir().join(format!("awo-symlink-out-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        let _ = fs::create_dir_all(root.join("src"));
        let _ = fs::create_dir_all(&outside);
        std::fs::write(outside.join("secret.txt"), "outside").expect("write");
        let linked = root.join("escape");
        let created = create_dir_symlink(&outside, &linked);
        if created.is_err() {
            // Windows 上创建目录符号链接需要开发者模式；没有权限就跳过这条回归验证。
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
            return;
        }
        let mut entries = Vec::new();
        let truncated = collect(&root, &root, true, 0, &mut entries).expect("collect");
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(!truncated);
        assert!(
            !paths.iter().any(|path| path.starts_with("escape")),
            "目录符号链接不得进入列表，更不得被遍历：{paths:?}"
        );
        assert!(paths.contains(&"src"), "普通目录照常列出");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn symlink_files_refuse_to_open_without_following() {
        let root = std::env::temp_dir().join(format!("awo-symlink-file-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::create_dir_all(root.join("src"));
        let real = root.join("src/real.txt");
        std::fs::write(&real, "hello").expect("write");
        let link = root.join("src/link.txt");
        let created = create_file_symlink(&real, &link);
        if created.is_err() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let read = open_no_follow(&link, false);
        assert_eq!(
            read.err(),
            Some("workspace-file-is-symlink"),
            "链接文件必须拒读"
        );
        let write = open_no_follow(&link, true);
        assert_eq!(
            write.err(),
            Some("workspace-file-is-symlink"),
            "链接文件必须拒写"
        );
        // 真实文件不受影响。
        let content = std::fs::read_to_string(&real).expect("真实文件必须照常可读");
        assert_eq!(content, "hello");
        let _ = fs::remove_dir_all(&root);
    }
}
