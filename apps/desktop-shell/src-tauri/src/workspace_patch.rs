//! 工作区补丁批量事务：add / delete / move 的原生入口（SEC-008 的批量化扩展）。
//!
//! 结构化补丁第一期只支持「覆写已存在文件」，走单文件票据即可。第二期放开
//! 新建 / 删除 / 移动后，一批补丁涉及多个文件的多种操作，引入两个原生命令：
//!
//! 1. `workspace_stage_patch_batch`：整批校验（路径语法、存在性前提、哈希、
//!    体积、重复目标）后签发**一张整批票据**——审批与内容被绑成同一份；
//! 2. `workspace_commit_patch`：原子消耗票据后落盘。先复核每条前提（磁盘
//!    可能已变），然后按序应用；任何一条失败立即回滚已应用的部分
//!    （从快照恢复原文），绝不留下半套改动还假装成功。
//!
//! 与单文件票据一致的限制：5 分钟时效、未消耗批次有上限、symlink 不穿透、
//! 单文件 2MB 上限、内容必须是 UTF-8。回滚尽力而为且如实报告——磁盘级
//! 真原子做不到，但「失败必须可见」是硬约束。

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::workspace_approval::{grantable_path, hash_hex, is_sha256_hex, GRANT_TTL_MS};
use crate::workspace_files::{
    ensure_regular_file, open_no_follow, to_relative_key, MAX_FILE_BYTES,
};
use crate::WorkspaceDirectoryState;

/// 未消耗批次上限：补丁批次比单文件票据更重，更少。
const MAX_OUTSTANDING_BATCHES: usize = 8;
/// 单批操作数上限：一次改动太多文件的审批本身就是审批疲劳。
pub const MAX_BATCH_OPERATIONS: usize = 32;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PatchOperation {
    /// "update"（可带 movePath）| "add" | "delete"。
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub move_path: Option<String>,
    /// update / delete / move 的源文件原文哈希；add 不需要。
    #[serde(default)]
    pub previous_sha256: Option<String>,
    /// update / add 的目标内容哈希；delete 不需要。
    #[serde(default)]
    pub next_sha256: Option<String>,
    /// update / add 的目标内容；delete 不需要。
    #[serde(default)]
    pub next_content: Option<String>,
}

struct WorkspacePatchBatch {
    operations: Vec<PatchOperation>,
    expires_at_ms: u128,
}

pub struct WorkspacePatchState(Mutex<HashMap<String, WorkspacePatchBatch>>);

impl WorkspacePatchState {
    pub fn new() -> Self {
        WorkspacePatchState(Mutex::new(HashMap::new()))
    }
}

impl Default for WorkspacePatchState {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn operation_error(op: &PatchOperation, code: &'static str) -> String {
    format!("{code}:{kind}:{path}", kind = op.kind, path = op.path)
}

/// 从 "code:kind:path" 形式的错误里解出错误码（给前端翻译用）。
pub fn operation_error_code(error: &str) -> &str {
    error.split(':').next().unwrap_or(error)
}

fn read_current(target: &Path) -> Result<Vec<u8>, &'static str> {
    let file = open_no_follow(target, false)?;
    ensure_regular_file(&file)?;
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "workspace-file-unreadable")?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("workspace-file-too-large");
    }
    Ok(bytes)
}

fn write_new_file(target: &Path, content: &[u8]) -> Result<(), &'static str> {
    // create_new 不会跟随已存在的重解析点：目标已被占用时直接失败，由前提校验兜底。
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|_| "workspace-file-unwritable")?;
    ensure_regular_file(&file)?;
    std::io::Write::write_all(&mut file, content).map_err(|_| "workspace-file-unwritable")?;
    file.sync_all().map_err(|_| "workspace-file-unwritable")
}

fn remove_file(target: &Path) -> Result<(), &'static str> {
    std::fs::remove_file(target).map_err(|_| "workspace-file-unwritable")
}

/// 校验单条操作并解析出涉及的路径：返回 (source, optional destination)。
fn resolve_operation(
    root: &Path,
    op: &PatchOperation,
) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>), String> {
    let source_relative = grantable_path(&op.path).map_err(|code| operation_error(op, code))?;
    let source = root.join(&source_relative);
    match op.kind.as_str() {
        "update" => {
            let previous = op
                .previous_sha256
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| operation_error(op, "workspace-patch-digest-missing"))?;
            if !is_sha256_hex(previous) {
                return Err(operation_error(op, "workspace-approval-digest-invalid"));
            }
            let content = op
                .next_content
                .as_deref()
                .ok_or_else(|| operation_error(op, "workspace-patch-content-missing"))?;
            if content.len() > MAX_FILE_BYTES {
                return Err(operation_error(op, "workspace-file-too-large"));
            }
            let next = op
                .next_sha256
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| operation_error(op, "workspace-patch-digest-missing"))?;
            if !is_sha256_hex(next) || hash_hex(content.as_bytes()) != next {
                return Err(operation_error(op, "workspace-approval-digest-invalid"));
            }
            let destination = match op.move_path.as_deref() {
                Some(move_path) => {
                    let destination_relative =
                        grantable_path(move_path).map_err(|code| operation_error(op, code))?;
                    if destination_relative == source_relative {
                        return Err(operation_error(op, "workspace-patch-move-self"));
                    }
                    Some(root.join(destination_relative))
                }
                None => None,
            };
            Ok((source, destination))
        }
        "add" => {
            let content = op
                .next_content
                .as_deref()
                .ok_or_else(|| operation_error(op, "workspace-patch-content-missing"))?;
            if content.len() > MAX_FILE_BYTES {
                return Err(operation_error(op, "workspace-file-too-large"));
            }
            let next = op
                .next_sha256
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| operation_error(op, "workspace-patch-digest-missing"))?;
            if !is_sha256_hex(next) || hash_hex(content.as_bytes()) != next {
                return Err(operation_error(op, "workspace-approval-digest-invalid"));
            }
            Ok((source, None))
        }
        "delete" => {
            let previous = op
                .previous_sha256
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| operation_error(op, "workspace-patch-digest-missing"))?;
            if !is_sha256_hex(previous) {
                return Err(operation_error(op, "workspace-approval-digest-invalid"));
            }
            Ok((source, None))
        }
        _ => Err(operation_error(op, "workspace-patch-kind-invalid")),
    }
}

/// 落盘前的存在性前提复核（stage 与 commit 都要过一遍；commit 是权威）。
/// add 的父目录必须已存在且不穿越符号链接；目标本身必须不存在。
fn verify_precondition(
    root: &Path,
    source: &Path,
    destination: Option<&Path>,
    op: &PatchOperation,
) -> Result<(), &'static str> {
    match op.kind.as_str() {
        "update" => {
            let current = read_current(source).map_err(|code| {
                if code == "workspace-path-not-found" {
                    "workspace-file-not-found"
                } else {
                    code
                }
            })?;
            let previous = op.previous_sha256.as_deref().unwrap_or_default();
            if hash_hex(&current) != previous {
                return Err("workspace-write-approval-stale");
            }
            if let Some(destination) = destination {
                if destination.symlink_metadata().is_ok() {
                    return Err("workspace-patch-destination-exists");
                }
                let parent = destination
                    .parent()
                    .ok_or("workspace-path-not-directory")?
                    .canonicalize()
                    .map_err(|_| "workspace-patch-parent-missing")?;
                if !parent.starts_with(root) {
                    return Err("workspace-path-escapes-root");
                }
            }
            Ok(())
        }
        "add" => {
            if source.symlink_metadata().is_ok() {
                return Err("workspace-file-already-exists");
            }
            let parent = source
                .parent()
                .ok_or("workspace-path-not-directory")?
                .canonicalize()
                .map_err(|_| "workspace-patch-parent-missing")?;
            if !parent.starts_with(root) {
                return Err("workspace-path-escapes-root");
            }
            Ok(())
        }
        "delete" => {
            let current = read_current(source).map_err(|code| {
                if code == "workspace-path-not-found" {
                    "workspace-file-not-found"
                } else {
                    code
                }
            })?;
            let previous = op.previous_sha256.as_deref().unwrap_or_default();
            if hash_hex(&current) != previous {
                return Err("workspace-write-approval-stale");
            }
            Ok(())
        }
        _ => Err("workspace-patch-kind-invalid"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatchBatchRequest {
    pub operations: Vec<PatchOperation>,
}

/// 整批签发一张一次性票据。全部前提在 stage 时先过一遍（快速失败给前端可读错误），
/// commit 时还会在磁盘上复核。
#[tauri::command]
pub fn workspace_stage_patch_batch(
    workspace: State<'_, WorkspaceDirectoryState>,
    state: State<'_, WorkspacePatchState>,
    request: WorkspacePatchBatchRequest,
) -> Result<String, String> {
    let root = crate::workspace_files::selected_root(&workspace).map_err(str::to_owned)?;
    let operations = request.operations;
    if operations.is_empty() {
        return Err("workspace-patch-empty".to_owned());
    }
    if operations.len() > MAX_BATCH_OPERATIONS {
        return Err("workspace-patch-too-many-operations".to_owned());
    }
    let mut seen = std::collections::HashSet::new();
    for op in &operations {
        let (source, destination) = resolve_operation(&root, op)?;
        let mut relatives = vec![to_relative_key(&root, &source)];
        if let Some(destination) = destination.as_ref() {
            relatives.push(to_relative_key(&root, destination));
        }
        for relative in relatives {
            if !seen.insert(relative) {
                return Err(operation_error(op, "workspace-patch-duplicate-path"));
            }
        }
        verify_precondition(&root, &source, destination.as_deref(), op).map_err(str::to_owned)?;
    }
    let mut batches = state
        .0
        .lock()
        .map_err(|_| "workspace-patch-state-unavailable".to_owned())?;
    let now = now_ms();
    batches.retain(|_, batch| batch.expires_at_ms > now);
    while batches.len() >= MAX_OUTSTANDING_BATCHES {
        let Some(oldest) = batches
            .iter()
            .min_by_key(|(_, batch)| batch.expires_at_ms)
            .map(|(token, _)| token.clone())
        else {
            break;
        };
        batches.remove(&oldest);
    }
    let mut token_bytes = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token: String = token_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    batches.insert(
        token.clone(),
        WorkspacePatchBatch {
            operations,
            expires_at_ms: now + GRANT_TTL_MS,
        },
    );
    Ok(token)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchOperationResult {
    pub kind: String,
    pub path: String,
    pub byte_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatchCommitResult {
    pub applied: Vec<PatchOperationResult>,
    /// 回滚成功的路径（commit 中途失败时）。
    pub rolled_back: Vec<String>,
    /// 回滚自身也失败的路径：必须原样告诉用户，人工善后。
    pub rollback_errors: Vec<String>,
}

/// 原子消耗整批票据并落盘；任何一条失败即回滚已应用部分。
#[tauri::command]
pub fn workspace_commit_patch(
    workspace: State<'_, WorkspaceDirectoryState>,
    approval: State<'_, WorkspacePatchState>,
    token: String,
) -> Result<WorkspacePatchCommitResult, String> {
    let root = crate::workspace_files::selected_root(&workspace).map_err(str::to_owned)?;
    let token = token.trim().to_owned();
    // 验证与移除在同一个锁内完成：两个并发 commit 不可能同时消耗同一批票据。
    let batch = {
        let mut batches = approval
            .0
            .lock()
            .map_err(|_| "workspace-patch-state-unavailable".to_owned())?;
        let batch = batches
            .remove(&token)
            .ok_or("workspace-write-approval-invalid".to_owned())?;
        if batch.expires_at_ms <= now_ms() {
            return Err("workspace-write-approval-invalid".to_owned());
        }
        batch
    };

    // 先整体复核前提并快照原文（delete/update/move 的源），任何失败都不落盘。
    let mut snapshots: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut resolved: Vec<(std::path::PathBuf, Option<std::path::PathBuf>)> = Vec::new();
    for (index, op) in batch.operations.iter().enumerate() {
        let (source, destination) = resolve_operation(&root, op)?;
        verify_precondition(&root, &source, destination.as_deref(), op).map_err(str::to_owned)?;
        if op.kind != "add" {
            let bytes = read_current(&source).map_err(str::to_owned)?;
            snapshots.push((index, bytes));
        }
        resolved.push((source, destination));
    }

    let mut applied: Vec<PatchOperationResult> = Vec::new();
    let mut rolled_back: Vec<String> = Vec::new();
    let mut rollback_errors: Vec<String> = Vec::new();
    for (index, op) in batch.operations.iter().enumerate() {
        let (source, destination) = &resolved[index];
        let outcome = (|| -> Result<usize, &'static str> {
            match op.kind.as_str() {
                "update" => {
                    let content = op.next_content.as_deref().unwrap_or_default();
                    if let Some(destination) = destination {
                        write_new_file(destination, content.as_bytes())?;
                        remove_file(source)?;
                        Ok(content.len())
                    } else {
                        let mut file = open_no_follow(source, true)?;
                        ensure_regular_file(&file)?;
                        std::io::Write::write_all(&mut file, content.as_bytes())
                            .map_err(|_| "workspace-file-unwritable")?;
                        file.sync_all().map_err(|_| "workspace-file-unwritable")?;
                        Ok(content.len())
                    }
                }
                "add" => {
                    let content = op.next_content.as_deref().unwrap_or_default();
                    write_new_file(source, content.as_bytes())?;
                    Ok(content.len())
                }
                "delete" => {
                    remove_file(source)?;
                    Ok(0)
                }
                _ => Err("workspace-patch-kind-invalid"),
            }
        })();
        match outcome {
            Ok(byte_size) => applied.push(PatchOperationResult {
                kind: op.kind.clone(),
                path: to_relative_key(&root, source),
                byte_size,
            }),
            Err(code) => {
                // 回滚已应用的部分：按逆序恢复快照。
                for (snapshot_index, bytes) in snapshots.iter().rev() {
                    if *snapshot_index >= index {
                        continue;
                    }
                    let snapshot_op = &batch.operations[*snapshot_index];
                    let (snapshot_source, snapshot_destination) = &resolved[*snapshot_index];
                    let restored = match snapshot_op.kind.as_str() {
                        // move：恢复源文件、删除已写出的目标。
                        "update" if snapshot_destination.is_some() => {
                            remove_file(snapshot_destination.as_ref().unwrap())
                                .and_then(|_| write_new_file(snapshot_source, bytes))
                        }
                        _ => write_new_file(snapshot_source, bytes),
                    };
                    match restored {
                        Ok(()) => rolled_back.push(to_relative_key(&root, snapshot_source)),
                        Err(_) => rollback_errors.push(to_relative_key(&root, snapshot_source)),
                    }
                }
                return Err(operation_error(op, code));
            }
        }
    }
    Ok(WorkspacePatchCommitResult {
        applied,
        rolled_back,
        rollback_errors,
    })
}

#[cfg(test)]
mod tests {
    use super::{operation_error, operation_error_code};

    #[test]
    fn operation_errors_round_trip_the_code() {
        let op = super::PatchOperation {
            kind: "add".to_owned(),
            path: "src/new.ts".to_owned(),
            move_path: None,
            previous_sha256: None,
            next_sha256: None,
            next_content: None,
        };
        let error = operation_error(&op, "workspace-file-already-exists");
        assert_eq!(
            operation_error_code(&error),
            "workspace-file-already-exists"
        );
        assert!(error.contains("add") && error.contains("src/new.ts"));
    }
}
