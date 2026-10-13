//! 工作区补丁批量事务：add / delete / move 的原生入口（SEC-008 的批量化扩展）。
//!
//! 安全模型（R1 审计整改后的完整形态）：
//!
//! * **统一路径隔离**：所有操作分两类解析——已有文件（update / delete / move 源）
//!   走 `resolve_within`（canonicalize 整条路径 + 前缀复核），中间目录是指向工作区外
//!   的符号链接会被直接拒绝；新路径（add / move 目标）走 `resolve_new`：词法拒绝
//!   穿越 + 逐级确认中间分量不是符号链接 + 父目录 canonicalize 归属复核。
//! * **票据绑定工作区身份**：stage 把 canonical root 存进批次；commit 发现根变了
//!   直接拒绝，不允许换一个工作区消耗票据。
//! * **失败回滚**：plan 阶段一次性对**全部**操作（含最终失败的那条）做前提复核并
//!   快照原文；apply 顺序执行，任何一条失败按逆序恢复——已应用的和**部分写入**的
//!   都会恢复（update 用截断写回，add 删除已创建文件，move 删目标 + 还原源）。
//!   回滚结果（成功与失败清单）完整进入错误串，绝不静默。
//! * **诚实的原子性**：跨普通文件做不到磁盘级真原子（崩溃/断电窗口仍在），本层
//!   保证的是「可预见的失败 → 可靠恢复 + 完整可见」；错误串里的回滚明细就是给
//!   人工善后用的恢复记录。
//!
//! 与单文件票据一致的限制：5 分钟时效、未消耗批次有上限、单文件 2MB、UTF-8。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::workspace_approval::{grantable_path, hash_hex, is_sha256_hex, GRANT_TTL_MS};
use crate::workspace_files::{
    ensure_regular_file, open_no_follow, reject_unsafe_relative, replace_file_contents,
    resolve_within, to_relative_key, MAX_FILE_BYTES,
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
    /// stage 时的 canonical 工作区根：票据绑定工作区身份，commit 时必须一致。
    root_canonical: PathBuf,
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

fn operation_error(op: &PatchOperation, code: &str) -> String {
    format!("{code}:{}:{}", op.kind, op.path)
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

/// 已存在文件的可靠还原：打开句柄后截断写回（不能用 create_new——文件还在）。
/// 事务账本：只记录**本次事务实际取得所有权**的变更。
/// 回滚时只处理账本内的对象，绝不凭路径无条件删除/改写别的进程创建的文件。
enum LedgerAction {
    /// 成功创建的路径（add 的目标、move 的新路径）：回滚 = 删除。
    Created(PathBuf),
    /// 成功改写的已存在文件（记录 plan 下标以取快照）：回滚 = 用快照原子替换。
    Modified(usize, PathBuf),
    /// 成功删除的文件：回滚 = 重建快照内容（路径已被他人重建时不覆盖，如实上报）。
    Deleted(usize, PathBuf),
}

fn remove_file(target: &Path) -> Result<(), &'static str> {
    std::fs::remove_file(target).map_err(|_| "workspace-file-unwritable")
}

fn write_new_file(target: &Path, content: &[u8]) -> Result<(), &'static str> {
    // create_new 不会跟随已存在的重解析点：目标已被占用时直接失败，由前提校验兜底。
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|_| "workspace-file-unwritable")?;
    ensure_regular_file(&file)?;
    // R4-05：创建成功后写失败会留下残留文件——自清理，回滚账本才无需为「创建
    // 了但没写完」的对象买单。
    if let Err(error) = (|| {
        file.write_all(content)
            .map_err(|_| "workspace-file-unwritable")?;
        file.sync_all().map_err(|_| "workspace-file-unwritable")
    })() {
        let _ = std::fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

/// 新路径解析（add / move 目标）：词法拒绝穿越后，逐级确认中间分量不是符号链接，
/// 最终分量必须不存在，父目录 canonicalize 后必须仍在根内。
/// 语义与 `resolve_within` 对称：不存在的目标无法 canonicalize，所以必须走这条路。
fn resolve_new(root_canonical: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    reject_unsafe_relative(relative)?;
    let candidate = root_canonical.join(relative);
    if !candidate.starts_with(root_canonical) {
        return Err("workspace-path-escapes-root");
    }
    let relative_components: Vec<_> = Path::new(relative).components().collect();
    let mut current = root_canonical.to_path_buf();
    for segment in relative_components
        .iter()
        .take(relative_components.len().saturating_sub(1))
    {
        current.push(segment);
        let metadata = current
            .symlink_metadata()
            .map_err(|_| "workspace-patch-parent-missing")?;
        if metadata.file_type().is_symlink() {
            // 中间目录是指向工作区外的链接：这是 R1 审计发现的越界路径，直接拒绝。
            return Err("workspace-path-escapes-root");
        }
        if !metadata.is_dir() {
            return Err("workspace-path-not-directory");
        }
    }
    // 最终分量：必须不存在（含悬空链接）。
    let final_path = current.join(relative_components.last().unwrap());
    if final_path.symlink_metadata().is_ok() {
        return Err("workspace-file-already-exists");
    }
    // 父目录真实身份复核（到这里父级已确认非链接；canonicalize 主要捕获
    // 检查之后父目录本身被换成链接的窗口）。
    let parent = final_path
        .parent()
        .ok_or("workspace-path-not-directory")?
        .canonicalize()
        .map_err(|_| "workspace-patch-parent-missing")?;
    if !parent.starts_with(root_canonical) {
        return Err("workspace-path-escapes-root");
    }
    Ok(final_path)
}

/// 一条操作的解析结果：源（已按类别安全解析）与可选目标。
struct ResolvedOperation {
    source: PathBuf,
    destination: Option<PathBuf>,
}

fn resolve_operation(
    root: &Path,
    root_canonical: &Path,
    op: &PatchOperation,
) -> Result<ResolvedOperation, String> {
    let source_relative = grantable_path(&op.path).map_err(|code| operation_error(op, code))?;
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
                    Some(
                        resolve_new(root_canonical, &destination_relative)
                            .map_err(|code| operation_error(op, code))?,
                    )
                }
                None => None,
            };
            // 已有文件：canonicalize 整条路径并确认在根内（中间符号链接在此被识破）。
            let source =
                resolve_within(root, &source_relative).map_err(|code| operation_error(op, code))?;
            Ok(ResolvedOperation {
                source,
                destination,
            })
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
            let source = resolve_new(root_canonical, &source_relative)
                .map_err(|code| operation_error(op, code))?;
            Ok(ResolvedOperation {
                source,
                destination: None,
            })
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
            let source =
                resolve_within(root, &source_relative).map_err(|code| operation_error(op, code))?;
            Ok(ResolvedOperation {
                source,
                destination: None,
            })
        }
        _ => Err(operation_error(op, "workspace-patch-kind-invalid")),
    }
}

/// 前提复核 + 快照。返回的 snapshot 对 add 是 None（回滚 = 删除已创建文件）。
fn verify_and_snapshot(
    op: &PatchOperation,
    resolved: &ResolvedOperation,
) -> Result<Option<Vec<u8>>, String> {
    let snapshot = match op.kind.as_str() {
        "update" => {
            let current = read_current(&resolved.source).map_err(|code| {
                if code == "workspace-path-not-found" {
                    operation_error(op, "workspace-file-not-found")
                } else {
                    operation_error(op, code)
                }
            })?;
            let previous = op.previous_sha256.as_deref().unwrap_or_default();
            if hash_hex(&current) != previous {
                return Err(operation_error(op, "workspace-write-approval-stale"));
            }
            if resolved.destination.is_some()
                && resolved
                    .destination
                    .as_ref()
                    .unwrap()
                    .symlink_metadata()
                    .is_ok()
            {
                return Err(operation_error(op, "workspace-patch-destination-exists"));
            }
            Some(current)
        }
        "add" => {
            if resolved.source.symlink_metadata().is_ok() {
                return Err(operation_error(op, "workspace-file-already-exists"));
            }
            None
        }
        "delete" => {
            let current = read_current(&resolved.source).map_err(|code| {
                if code == "workspace-path-not-found" {
                    operation_error(op, "workspace-file-not-found")
                } else {
                    operation_error(op, code)
                }
            })?;
            let previous = op.previous_sha256.as_deref().unwrap_or_default();
            if hash_hex(&current) != previous {
                return Err(operation_error(op, "workspace-write-approval-stale"));
            }
            Some(current)
        }
        _ => return Err(operation_error(op, "workspace-patch-kind-invalid")),
    };
    Ok(snapshot)
}

/// 计划：解析 + 前提复核 + 快照，全部完成后才允许 apply。
struct PatchPlan {
    operations: Vec<PatchOperation>,
    resolved: Vec<ResolvedOperation>,
    snapshots: Vec<Option<Vec<u8>>>,
}

fn plan_batch(
    root: &Path,
    root_canonical: &Path,
    operations: Vec<PatchOperation>,
) -> Result<PatchPlan, String> {
    if operations.is_empty() {
        return Err("workspace-patch-empty".to_owned());
    }
    if operations.len() > MAX_BATCH_OPERATIONS {
        return Err("workspace-patch-too-many-operations".to_owned());
    }
    let mut seen = std::collections::HashSet::new();
    let mut resolved = Vec::with_capacity(operations.len());
    let mut snapshots = Vec::with_capacity(operations.len());
    for op in &operations {
        let resolved_op = resolve_operation(root, root_canonical, op)?;
        let mut relatives = vec![to_relative_key(root, &resolved_op.source)];
        if let Some(destination) = resolved_op.destination.as_ref() {
            relatives.push(to_relative_key(root, destination));
        }
        for relative in relatives {
            if !seen.insert(relative) {
                return Err(operation_error(op, "workspace-patch-duplicate-path"));
            }
        }
        let snapshot = verify_and_snapshot(op, &resolved_op)?;
        resolved.push(resolved_op);
        snapshots.push(snapshot);
    }
    Ok(PatchPlan {
        operations,
        resolved,
        snapshots,
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PatchOperationResult {
    pub kind: String,
    pub path: String,
    pub byte_size: usize,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatchCommitResult {
    pub applied: Vec<PatchOperationResult>,
    /// 回滚成功的路径（commit 中途失败时）。
    pub rolled_back: Vec<String>,
    /// 回滚自身也失败的路径：必须原样告诉用户，人工善后。
    pub rollback_errors: Vec<String>,
}

fn apply_single(
    op: &PatchOperation,
    resolved: &ResolvedOperation,
    index: usize,
    ledger: &mut Vec<LedgerAction>,
) -> Result<usize, &'static str> {
    match op.kind.as_str() {
        "update" => {
            let content = op.next_content.as_deref().unwrap_or_default();
            if let Some(destination) = &resolved.destination {
                // move：先建目标再删源。账本按实际取得的每一步所有权记录——
                // 第二步失败时，第一步已创建的目标仍属本事务，回滚会清理它。
                write_new_file(destination, content.as_bytes())?;
                ledger.push(LedgerAction::Created(destination.clone()));
                remove_file(resolved.source.as_path())?;
                ledger.push(LedgerAction::Deleted(index, resolved.source.clone()));
                Ok(content.len())
            } else {
                // 临时文件 + 原子换名：失败时原文完整保留，不存在「部分写入」。
                replace_file_contents(resolved.source.as_path(), content.as_bytes())?;
                ledger.push(LedgerAction::Modified(index, resolved.source.clone()));
                Ok(content.len())
            }
        }
        "add" => {
            let content = op.next_content.as_deref().unwrap_or_default();
            write_new_file(resolved.source.as_path(), content.as_bytes())?;
            ledger.push(LedgerAction::Created(resolved.source.clone()));
            Ok(content.len())
        }
        "delete" => {
            remove_file(resolved.source.as_path())?;
            ledger.push(LedgerAction::Deleted(index, resolved.source.clone()));
            Ok(0)
        }
        _ => Err("workspace-patch-kind-invalid"),
    }
}

/// 失败回滚：只处理账本内、本次事务实际取得所有权的对象，按逆序撤销。
/// 回滚明细同时进入错误串，绝不静默。
fn rollback_from(
    plan: &PatchPlan,
    root: &Path,
    failed_index: usize,
    code: &str,
    ledger: &[LedgerAction],
) -> String {
    let mut rolled_back = Vec::new();
    let mut rollback_errors = Vec::new();
    for action in ledger.iter().rev() {
        let outcome = match action {
            LedgerAction::Created(path) => {
                // 只删除本事务创建的文件；create_new 成功后才入账，路径内容属于我们。
                match std::fs::remove_file(path) {
                    Ok(()) => Ok(()),
                    Err(_) if path.symlink_metadata().is_err() => Ok(()),
                    Err(_) => Err("workspace-file-unwritable"),
                }
            }
            LedgerAction::Modified(index, path) => {
                replace_file_contents(path, plan.snapshots[*index].as_deref().unwrap_or_default())
            }
            LedgerAction::Deleted(index, path) => {
                // 重建被删除的文件；若他人已在此路径重建了新文件，不覆盖，
                // 如实计入 rollback_errors 由人工核对。
                if path.symlink_metadata().is_ok() {
                    Err("workspace-file-unwritable")
                } else {
                    write_new_file(path, plan.snapshots[*index].as_deref().unwrap_or_default())
                }
            }
        };
        let relative = match action {
            LedgerAction::Created(path) => to_relative_key(root, path),
            LedgerAction::Modified(_, path) | LedgerAction::Deleted(_, path) => {
                to_relative_key(root, path)
            }
        };
        match outcome {
            Ok(()) => rolled_back.push(relative),
            Err(_) => rollback_errors.push(relative),
        }
    }
    format!(
        "{}|rolledBack={}|rollbackErrors={}",
        operation_error(&plan.operations[failed_index], code),
        rolled_back.join(","),
        rollback_errors.join(",")
    )
}

/// apply：顺序执行；失败即回滚并返回带完整回滚明细的错误。
fn apply_batch_with_root(
    plan: &PatchPlan,
    root: &Path,
) -> Result<WorkspacePatchCommitResult, String> {
    let mut applied: Vec<PatchOperationResult> = Vec::new();
    let mut ledger: Vec<LedgerAction> = Vec::new();
    for (index, op) in plan.operations.iter().enumerate() {
        let resolved = &plan.resolved[index];
        match apply_single(op, resolved, index, &mut ledger) {
            Ok(byte_size) => applied.push(PatchOperationResult {
                kind: op.kind.clone(),
                path: to_relative_key(
                    root,
                    resolved.destination.as_ref().unwrap_or(&resolved.source),
                ),
                byte_size,
            }),
            Err(code) => return Err(rollback_from(plan, root, index, code, &ledger)),
        }
    }
    Ok(WorkspacePatchCommitResult {
        applied,
        rolled_back: Vec::new(),
        rollback_errors: Vec::new(),
    })
}

#[cfg(test)]
pub fn operation_error_code(error: &str) -> &str {
    error
        .split('|')
        .next()
        .unwrap_or(error)
        .split(':')
        .next()
        .unwrap_or(error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatchBatchRequest {
    pub operations: Vec<PatchOperation>,
}

/// 整批签发一张一次性票据。全部前提在 stage 时先过一遍（快速失败给前端可读错误），
/// commit 时还会重新计划（重开文件、重算哈希）。
#[tauri::command]
pub fn workspace_stage_patch_batch(
    workspace: State<'_, WorkspaceDirectoryState>,
    state: State<'_, WorkspacePatchState>,
    request: WorkspacePatchBatchRequest,
) -> Result<String, String> {
    let root = crate::workspace_files::selected_root(&workspace).map_err(str::to_owned)?;
    let root_canonical = root
        .canonicalize()
        .map_err(|_| "workspace-root-unavailable".to_owned())?;
    let operations = request.operations.clone();
    // stage 就做一次完整计划（解析 + 前提 + 快照），把可预见的错误挡在票据之前。
    plan_batch(&root, &root_canonical, operations)?;
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
            operations: request.operations,
            root_canonical,
            expires_at_ms: now + GRANT_TTL_MS,
        },
    );
    Ok(token)
}

/// 原子消耗整批票据并落盘；任何一条失败即回滚已应用（含部分写入）的部分。
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
    // 票据绑定工作区身份：stage 与 commit 之间根目录被更换是明确的拒绝条件。
    let root_canonical = root
        .canonicalize()
        .map_err(|_| "workspace-root-unavailable".to_owned())?;
    if root_canonical != batch.root_canonical {
        return Err("workspace-patch-workspace-changed".to_owned());
    }
    // 重新计划（前提复核 + 快照），随后立即应用——复核与写入之间没有等待点。
    // 路径归一用 canonical root：resolve_within 返回的源路径与之同形式。
    let plan = plan_batch(&root, &root_canonical, batch.operations)?;
    apply_batch_with_root(&plan, &root_canonical)
}

#[cfg(test)]
mod tests {
    use super::{apply_batch_with_root, operation_error, plan_batch, PatchOperation};
    use std::path::{Path, PathBuf};

    fn op(kind: &str, path: &str) -> PatchOperation {
        PatchOperation {
            kind: kind.to_owned(),
            path: path.to_owned(),
            move_path: None,
            previous_sha256: None,
            next_sha256: None,
            next_content: None,
        }
    }

    fn sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn update_op(path: &str, previous: &[u8], next: &str) -> PatchOperation {
        PatchOperation {
            previous_sha256: Some(sha(previous)),
            next_sha256: Some(sha(next.as_bytes())),
            next_content: Some(next.to_owned()),
            ..op("update", path)
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("awo-patch-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    fn temp_outside(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("awo-patch-outside-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 创建目录符号链接；Windows 未开开发者模式时返回 false，用例跳过。
    fn create_dir_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            match std::os::windows::fs::symlink_dir(target, link) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => false,
                Err(error) => panic!("{}", error),
            }
        }
    }

    #[test]
    fn operation_errors_round_trip_the_code() {
        let op = op("add", "src/new.ts");
        let error = operation_error(&op, "workspace-file-already-exists");
        assert_eq!(
            super::operation_error_code(&error),
            "workspace-file-already-exists"
        );
        assert!(error.contains("add") && error.contains("src/new.ts"));
    }

    #[test]
    fn update_add_delete_round_trip_and_report_relative_paths() {
        let root = temp_root("round-trip");
        let root_canonical = root.canonicalize().unwrap();
        std::fs::write(root.join("src/a.ts"), "alpha\n").unwrap();
        std::fs::write(root.join("src/gone.txt"), "alpha\n").unwrap();
        let operations = vec![
            update_op("src/a.ts", b"alpha\n", "ALPHA\n"),
            PatchOperation {
                next_sha256: Some(sha(b"fresh\n")),
                next_content: Some("fresh\n".to_owned()),
                ..op("add", "src/new.ts")
            },
            PatchOperation {
                previous_sha256: Some(sha(b"alpha\n")),
                ..op("delete", "src/gone.txt")
            },
        ];
        let plan = plan_batch(&root, &root_canonical, operations).unwrap();
        let result = apply_batch_with_root(&plan, &root_canonical).unwrap();
        assert_eq!(result.applied.len(), 3);
        assert_eq!(
            std::fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "ALPHA\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/new.ts")).unwrap(),
            "fresh\n"
        );
        assert!(!root.join("src/gone.txt").exists());
        assert_eq!(result.rolled_back.len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn intermediate_symlink_escape_is_rejected_for_update_delete_and_move() {
        let root = temp_root("symlink-escape");
        let root_canonical = root.canonicalize().unwrap();
        std::fs::write(root.join("src/inside.txt"), "inside\n").unwrap();
        let outside = temp_outside("symlink-escape");
        std::fs::write(outside.join("config.txt"), "secret\n").unwrap();
        if !create_dir_symlink(&outside, &root.join("external-link")) {
            // Windows 未开开发者模式：符号链接用例在 Unix 上已覆盖，此处跳过。
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }
        // update / delete / move 的源经过中间链接 → 全部拒绝，绝不读写外部文件。
        let update_outside = vec![update_op(
            "external-link/config.txt",
            b"secret\n",
            "hacked\n",
        )];
        assert!(plan_batch(&root, &root_canonical, update_outside).is_err());
        let delete_outside = vec![PatchOperation {
            previous_sha256: Some(sha(b"secret\n")),
            ..op("delete", "external-link/config.txt")
        }];
        assert!(plan_batch(&root, &root_canonical, delete_outside).is_err());
        let move_outside = vec![PatchOperation {
            move_path: Some("src/moved.txt".to_owned()),
            ..update_op("external-link/config.txt", b"secret\n", "moved\n")
        }];
        assert!(plan_batch(&root, &root_canonical, move_outside).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("config.txt")).unwrap(),
            "secret\n"
        );
        // move 目标经过中间链接同样拒绝。
        let move_into_link = vec![PatchOperation {
            move_path: Some("external-link/moved.txt".to_owned()),
            ..update_op("src/inside.txt", b"inside\n", "moved\n")
        }];
        assert!(plan_batch(&root, &root_canonical, move_into_link).is_err());
        assert!(!outside.join("moved.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn add_into_symlinked_directory_is_rejected() {
        let root = temp_root("add-symlink");
        let root_canonical = root.canonicalize().unwrap();
        let outside = temp_outside("add-symlink");
        if !create_dir_symlink(&outside, &root.join("link")) {
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }
        let operations = vec![PatchOperation {
            next_sha256: Some(sha(b"x\n")),
            next_content: Some("x\n".to_owned()),
            ..op("add", "link/new.txt")
        }];
        assert!(plan_batch(&root, &root_canonical, operations).is_err());
        assert!(!outside.join("new.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn failure_rolls_back_applied_and_partially_written_ops() {
        let root = temp_root("rollback");
        let root_canonical = root.canonicalize().unwrap();
        std::fs::write(root.join("src/a.ts"), "alpha\n").unwrap();
        std::fs::write(root.join("src/locked.txt"), "locked\n").unwrap();
        let operations = vec![
            update_op("src/a.ts", b"alpha\n", "ALPHA\n"),
            update_op("src/locked.txt", b"locked\n", "CHANGED\n"),
        ];
        let plan = plan_batch(&root, &root_canonical, operations).unwrap();
        // 注入故障：第二条 update 的源文件在计划之后被设为只读（模拟写失败）。
        let set_readonly = |readonly: bool| {
            let mut permissions = std::fs::metadata(root.join("src/locked.txt"))
                .unwrap()
                .permissions();
            permissions.set_readonly(readonly);
            std::fs::set_permissions(root.join("src/locked.txt"), permissions).unwrap();
        };
        set_readonly(true);
        let result = apply_batch_with_root(&plan, &root_canonical);
        match result {
            Err(error) => {
                assert!(
                    error.starts_with("workspace-file-unwritable:update:src/locked.txt|"),
                    "{error}"
                );
                // R2 语义：失败这条走「临时文件 + 原子换名」，失败时原文完整保留、
                // 不产生部分写入，因此不进任何回滚清单；已应用的第一条恢复成功。
                assert!(error.contains("rolledBack=src/a.ts"), "{error}");
                assert!(error.contains("rollbackErrors="), "{error}");
                // 磁盘状态：第一条已还原，第二条从未被改写。
                assert_eq!(
                    std::fs::read_to_string(root.join("src/a.ts")).unwrap(),
                    "alpha\n"
                );
                assert_eq!(
                    std::fs::read_to_string(root.join("src/locked.txt")).unwrap(),
                    "locked\n"
                );
            }
            Ok(applied) => {
                // Windows 只读属性不总是阻止写入（取决于进程权限）；成功路径允许，
                // 但两个文件都必须已被写入（没有半套状态）。
                assert_eq!(applied.applied.len(), 2);
            }
        }
        set_readonly(false);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 故障注入模式：plan 与 apply 是分离的两个阶段——先让整批计划通过，
    /// 再在 apply 前移除某个目标父目录，即可在**所有平台**上确定性地让
    /// 指定操作失败，验证真实回滚路径。
    #[test]
    fn delete_rollback_recreates_the_removed_file() {
        let root = temp_root("delete-rollback");
        let root_canonical = root.canonicalize().unwrap();
        std::fs::write(root.join("src/a.ts"), "alpha\n").unwrap();
        std::fs::write(root.join("src/locked.txt"), "locked\n").unwrap();
        std::fs::create_dir_all(root.join("src/out")).unwrap();
        let operations = vec![
            PatchOperation {
                previous_sha256: Some(sha(b"alpha\n")),
                ..op("delete", "src/a.ts")
            },
            PatchOperation {
                move_path: Some("src/out/dest.txt".to_owned()),
                ..update_op("src/locked.txt", b"locked\n", "moved\n")
            },
        ];
        let plan = plan_batch(&root, &root_canonical, operations).unwrap();
        // 注入故障：第二条 move 的目标父目录在 apply 前消失。
        std::fs::remove_dir_all(root.join("src/out")).unwrap();
        let error = apply_batch_with_root(&plan, &root_canonical).unwrap_err();
        // 已删除的 a.ts 必须从快照重建（R1 缺陷：旧回滚对已删除文件用「打开已存在」必失败）。
        assert!(error.contains("rolledBack=src/a.ts"), "{error}");
        assert_eq!(
            std::fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "alpha\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/locked.txt")).unwrap(),
            "locked\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn move_rollback_restores_source_and_removes_created_destination() {
        let root = temp_root("move-rollback");
        let root_canonical = root.canonicalize().unwrap();
        std::fs::write(root.join("src/a.ts"), "alpha\n").unwrap();
        std::fs::write(root.join("src/locked.txt"), "locked\n").unwrap();
        std::fs::create_dir_all(root.join("src/out")).unwrap();
        std::fs::create_dir_all(root.join("src/other")).unwrap();
        let operations = vec![
            PatchOperation {
                move_path: Some("src/out/dest.txt".to_owned()),
                ..update_op("src/locked.txt", b"locked\n", "moved\n")
            },
            PatchOperation {
                next_sha256: Some(sha(b"x\n")),
                next_content: Some("x\n".to_owned()),
                ..op("add", "src/other/newfile.txt")
            },
        ];
        let plan = plan_batch(&root, &root_canonical, operations).unwrap();
        // 只移除第二条 add 的父目录：move 成功入账后才发生故障。
        std::fs::remove_dir_all(root.join("src/other")).unwrap();
        let error = apply_batch_with_root(&plan, &root_canonical).unwrap_err();
        // move 已成功：回滚要删除本事务创建的目标、重建已删除的源（两条都在账本里）。
        assert!(
            error.contains("rolledBack=src/locked.txt,src/out/dest.txt"),
            "{error}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/locked.txt")).unwrap(),
            "locked\n"
        );
        assert!(!root.join("src/out/dest.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "alpha\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_add_never_deletes_a_file_created_by_another_process() {
        let root = temp_root("add-race");
        let root_canonical = root.canonicalize().unwrap();
        std::fs::write(root.join("src/a.ts"), "alpha\n").unwrap();
        std::fs::create_dir_all(root.join("src/out")).unwrap();
        let operations = vec![
            PatchOperation {
                next_sha256: Some(sha(b"fresh\n")),
                next_content: Some("fresh\n".to_owned()),
                ..op("add", "src/new.ts")
            },
            PatchOperation {
                next_sha256: Some(sha(b"x\n")),
                next_content: Some("x\n".to_owned()),
                ..op("add", "src/out/newfile.txt")
            },
        ];
        let plan = plan_batch(&root, &root_canonical, operations).unwrap();
        // 竞态：apply 之前，另一个进程已经在 src/new.ts 创建了自己的文件。
        std::fs::write(root.join("src/new.ts"), "other-process\n").unwrap();
        std::fs::remove_dir_all(root.join("src/out")).unwrap();
        let error = apply_batch_with_root(&plan, &root_canonical).unwrap_err();
        // 本事务的 create_new 失败 → 该路径从未入账 → 回滚绝不能删除别人的文件。
        assert!(
            error.starts_with("workspace-file-unwritable:add:src/new.ts|"),
            "{error}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/new.ts")).unwrap(),
            "other-process\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "alpha\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
