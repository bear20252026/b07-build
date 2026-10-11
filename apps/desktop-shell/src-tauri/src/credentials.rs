//! SEC-006/007：操作系统级凭据存取。
//!
//! API key 与 GitHub PAT 之前存在 WebView 的 localStorage（明文 JSON），任何能读
//! 该用户 WebView 存储目录的进程都能拿到。现在统一迁入系统凭据管理器
//! （Windows Credential Manager / macOS Keychain / Linux keyutils）：
//!
//! - 前端通过 `credential_store` / `credential_load` / `credential_delete` 三个
//!   命令读写，凭据内容不进 localStorage、不进聊天与诊断数据。
//! - service 固定为 `awo-desktop-shell`；account 由前端给定（如
//!   `provider/<providerId>`、`github/token`），这里只接受受限字符集，
//!   防止把任意字符串塞进凭据管理器或拼接出越权条目。
//! - 密钥本体只在命令参数与 keyring 之间搬运，不落日志、不落磁盘文件。

use keyring::Entry;

const SERVICE: &str = "awo-desktop-shell";

fn validate_account(account: &str) -> Result<(), &'static str> {
    if account.is_empty() || account.len() > 128 {
        return Err("credential-account-invalid");
    }
    let mut chars = account.chars();
    let first = chars.next().unwrap_or_default();
    if !(first.is_ascii_alphanumeric()) {
        return Err("credential-account-invalid");
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '@' | '-' | ':')) {
        return Err("credential-account-invalid");
    }
    Ok(())
}

fn entry(account: &str) -> Result<Entry, &'static str> {
    validate_account(account)?;
    Entry::new(SERVICE, account).map_err(|_| "credential-entry-unavailable")
}

/// 写入或更新一条凭据。
#[tauri::command]
pub fn credential_store(account: String, secret: String) -> Result<(), &'static str> {
    if secret.is_empty() || secret.len() > 4096 {
        return Err("credential-secret-invalid");
    }
    entry(&account)?
        .set_password(&secret)
        .map_err(|_| "credential-store-failed")
}

/// 读取一条凭据；不存在时返回 None（不算错误）。
#[tauri::command]
pub fn credential_load(account: String) -> Result<Option<String>, &'static str> {
    match entry(&account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("credential-load-failed"),
    }
}

/// 删除一条凭据；本就不存在时视为成功。
#[tauri::command]
pub fn credential_delete(account: String) -> Result<(), &'static str> {
    match entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("credential-delete-failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_restricted() {
        assert_eq!(validate_account("provider/mimo-token-plan-cn"), Ok(()));
        assert_eq!(validate_account("github/token"), Ok(()));
        assert_eq!(validate_account("github/token v2"), Err("credential-account-invalid"));
        assert_eq!(validate_account("../escape"), Err("credential-account-invalid"));
        assert_eq!(validate_account(""), Err("credential-account-invalid"));
        assert_eq!(validate_account(&"a".repeat(129)), Err("credential-account-invalid"));
    }

    #[test]
    fn secrets_are_bounded() {
        // 只验证命令入口的边界检查，不真正触碰用户的凭据管理器。
        assert_eq!(
            credential_store("provider/__test__".to_string(), String::new()),
            Err("credential-secret-invalid")
        );
        assert_eq!(
            credential_store("provider/__test__".to_string(), "x".repeat(4097)),
            Err("credential-secret-invalid")
        );
        assert_eq!(credential_store("../escape".to_string(), "x".to_string()), Err("credential-account-invalid"));
    }
}
