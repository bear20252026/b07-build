//! 工作区写入授权票据（SEC-008）。
//!
//! 之前「Agent 想改文件 → 前端弹窗 → 前端自己调 workspace_write_file」的链路里，
//! 审批只是前端的一个约定：任何能直接调用原生命令的代码都可以绕过弹窗写文件。
//!
//! 现在审批被物化成一张**原生票据**：
//!   - 绑定「路径 + 原文 SHA-256 + 目标内容 SHA-256 + 5 分钟时效」；
//!   - `workspace_write_file` 必须携带票据，原生侧逐项验证后**原子消耗**（一次性）；
//!   - 写入前用票据里的 previous 哈希复核磁盘上的真实内容——
//!     弹窗里给用户看的 diff 和真正落盘的内容被绑成同一份，文件在审批后被
//!     其它进程改过时写入会被拒绝（stale），而不是静默覆盖别人的改动。
//!
//! 这不能阻止「整个 WebView 已经沦陷」的攻击者（它自己就能 stage 票据），
//! 但能挡住三类更现实的问题：绕过弹窗的直接调用、审批后文件被第三方改动、
//! 以及同一条审批被重复使用。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use tauri::State;

use crate::WorkspaceDirectoryState;

/// 票据有效期。用户看完 diff 点一下确认只要几秒，5 分钟已经非常宽裕。
pub const GRANT_TTL_MS: u128 = 5 * 60 * 1000;
/// 未消耗票据上限：超过就先淘汰最早过期的，防止被无限堆积极占内存。
const MAX_OUTSTANDING_GRANTS: usize = 64;

pub(crate) struct Grant {
    /// 写入目标，`to_relative_key` 规范化后的相对路径（`/` 分隔）。
    pub(crate) path: String,
    pub(crate) previous_sha256: String,
    pub(crate) next_sha256: String,
    pub(crate) expires_at_ms: u128,
}

pub struct WorkspaceApprovalState(Mutex<HashMap<String, Grant>>);

impl WorkspaceApprovalState {
    pub fn new() -> Self {
        WorkspaceApprovalState(Mutex::new(HashMap::new()))
    }
}

impl Default for WorkspaceApprovalState {
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

pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 语法层校验票据要绑定的相对路径：非空、非绝对、不允许向上穿越。
/// 真正的边界校验仍在写入时由 canonicalize 前缀检查完成，这里只挡明显恶意输入。
pub(crate) fn grantable_path(path: &str) -> Result<String, &'static str> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > 512 {
        return Err("workspace-path-invalid");
    }
    if trimmed.starts_with('/') || trimmed.contains('\\') || trimmed.contains(':') {
        return Err("workspace-path-absolute");
    }
    if trimmed.split('/').any(|segment| segment == "..") {
        return Err("workspace-path-escapes-root");
    }
    Ok(trimmed.to_owned())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 领取一张一次性写入票据。调用方必须先算好「原文哈希」与「目标内容哈希」——
/// 也就是说，领票据这个动作本身就要求调用方已经知道并展示过它要覆盖的内容。
#[tauri::command]
pub fn workspace_stage_write_approval(
    directory: State<'_, WorkspaceDirectoryState>,
    state: State<'_, WorkspaceApprovalState>,
    path: String,
    previous_sha256: String,
    next_sha256: String,
) -> Result<String, &'static str> {
    directory
        .0
        .lock()
        .map_err(|_| "workspace-root-unavailable")?
        .is_some()
        .then_some(())
        .ok_or("workspace-root-not-selected")?;
    let path = grantable_path(&path)?;
    let previous = previous_sha256.trim().to_ascii_lowercase();
    let next = next_sha256.trim().to_ascii_lowercase();
    if !is_sha256_hex(&previous) || !is_sha256_hex(&next) {
        return Err("workspace-approval-digest-invalid");
    }
    if previous == next {
        // 内容没变就不该有任何写入，更不该为它发票据。
        return Err("workspace-approval-content-unchanged");
    }
    let mut grants = state
        .0
        .lock()
        .map_err(|_| "workspace-approval-unavailable")?;
    let now = now_ms();
    grants.retain(|_, grant| grant.expires_at_ms > now);
    while grants.len() >= MAX_OUTSTANDING_GRANTS {
        let Some(oldest) = grants
            .iter()
            .min_by_key(|(_, grant)| grant.expires_at_ms)
            .map(|(token, _)| token.clone())
        else {
            break;
        };
        grants.remove(&oldest);
    }
    let mut token_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token: String = token_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    grants.insert(
        token.clone(),
        Grant {
            path,
            previous_sha256: previous,
            next_sha256: next,
            expires_at_ms: now + GRANT_TTL_MS,
        },
    );
    Ok(token)
}

/// 原子消耗一张票据并返回它。验证与移除在同一个锁内完成，
/// 两个并发写入不可能同时消耗同一条审批。
pub(crate) fn consume_grant(
    state: &State<'_, WorkspaceApprovalState>,
    token: &str,
) -> Result<Grant, &'static str> {
    let mut grants = state
        .0
        .lock()
        .map_err(|_| "workspace-approval-unavailable")?;
    let grant = grants
        .remove(token)
        .ok_or("workspace-write-approval-invalid")?;
    if grant.expires_at_ms <= now_ms() {
        return Err("workspace-write-approval-invalid");
    }
    Ok(grant)
}

pub(crate) fn hash_hex(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

#[cfg(test)]
mod tests {
    use super::{grantable_path, is_sha256_hex};

    #[test]
    fn digests_must_be_full_lowercaseable_sha256() {
        assert!(is_sha256_hex(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ));
        assert!(!is_sha256_hex("abc"));
        assert!(!is_sha256_hex(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85"
        ));
        assert!(!is_sha256_hex(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85g"
        ));
    }

    #[test]
    fn grant_paths_reject_traversal_and_absolute_forms() {
        assert_eq!(grantable_path("src/main.rs").as_deref(), Ok("src/main.rs"));
        assert_eq!(
            grantable_path("  src/main.rs ").as_deref(),
            Ok("src/main.rs")
        );
        assert_eq!(
            grantable_path("../secrets"),
            Err("workspace-path-escapes-root")
        );
        assert_eq!(
            grantable_path("a/../../b"),
            Err("workspace-path-escapes-root")
        );
        assert_eq!(
            grantable_path("/etc/passwd"),
            Err("workspace-path-absolute")
        );
        assert_eq!(grantable_path("C:\\x"), Err("workspace-path-absolute"));
        assert_eq!(grantable_path(""), Err("workspace-path-invalid"));
    }
}
