//! 会话账本的 SQLite 持久化。
//!
//! 存放位置是应用数据目录下的 `conversations.sqlite`（WAL）。每个会话单独一行、payload 为
//! 该会话自身的 JSON，因此一次改动只写一行，而不是像 WebView localStorage 那样整库重写。
//! WebView 侧只能拿到校验过的 DTO，不接触数据库文件、路径或 SQL。

use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DATABASE_FILE: &str = "conversations.sqlite";
const MAX_PAYLOAD_BYTES: usize = 24 * 1024 * 1024;
const BUSY_TIMEOUT_MS: u16 = 5_000;

fn conversation_directory(app: &AppHandle) -> Result<PathBuf, &'static str> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "conversation-store-directory-unavailable")?;
    std::fs::create_dir_all(&directory).map_err(|_| "conversation-store-directory-unavailable")?;
    Ok(directory)
}

fn valid_conversation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn open(app: &AppHandle) -> Result<Connection, &'static str> {
    let path = conversation_directory(app)?.join(DATABASE_FILE);
    let connection = Connection::open(path).map_err(|_| "conversation-store-open-failed")?;
    connection
        .busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS.into()))
        .map_err(|_| "conversation-store-open-failed")?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS conversations (
               id TEXT PRIMARY KEY,
               payload TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS conversations_updated_at ON conversations (updated_at DESC);",
        )
        .map_err(|_| "conversation-store-schema-failed")?;
    Ok(connection)
}

fn payload_text(value: &Value) -> Result<String, &'static str> {
    let text = serde_json::to_string(value).map_err(|_| "conversation-store-payload-invalid")?;
    if text.is_empty() || text.len() > MAX_PAYLOAD_BYTES {
        return Err("conversation-store-payload-too-large");
    }
    Ok(text)
}

#[tauri::command]
pub fn conversation_store_load(app: AppHandle) -> Result<Vec<Value>, &'static str> {
    let connection = open(&app)?;
    let mut statement = connection
        .prepare("SELECT payload FROM conversations ORDER BY updated_at DESC")
        .map_err(|_| "conversation-store-read-failed")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "conversation-store-read-failed")?;
    let mut payloads: Vec<Value> = Vec::new();
    for row in rows {
        let text = row.map_err(|_| "conversation-store-read-failed")?;
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => payloads.push(value),
            Err(_) => continue, // 单行损坏跳过，不因一条记录让整个账本不可用
        }
    }
    Ok(payloads)
}

#[tauri::command]
pub fn conversation_store_upsert(app: AppHandle, conversation: Value) -> Result<(), &'static str> {
    let id = conversation
        .get("id")
        .and_then(Value::as_str)
        .ok_or("conversation-store-id-invalid")?;
    if !valid_conversation_id(id) {
        return Err("conversation-store-id-invalid");
    }
    let updated_at = conversation
        .get("updatedAt")
        .and_then(Value::as_u64)
        .unwrap_or(0) as i64;
    let payload = payload_text(&conversation)?;
    let connection = open(&app)?;
    connection
        .execute(
            "INSERT INTO conversations (id, payload, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
            params![id, payload, updated_at],
        )
        .map_err(|_| "conversation-store-write-failed")?;
    Ok(())
}

#[tauri::command]
pub fn conversation_store_remove(app: AppHandle, id: String) -> Result<(), &'static str> {
    if !valid_conversation_id(&id) {
        return Err("conversation-store-id-invalid");
    }
    let connection = open(&app)?;
    connection
        .execute("DELETE FROM conversations WHERE id = ?1", params![id])
        .map_err(|_| "conversation-store-write-failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_conversation_id;

    #[test]
    fn accepts_generated_conversation_identifiers() {
        assert!(valid_conversation_id("conversation-0123456789abcdefabcd"));
    }

    #[test]
    fn rejects_traversal_and_foreign_identifiers() {
        assert!(!valid_conversation_id("../escape"));
        assert!(!valid_conversation_id(""));
        assert!(!valid_conversation_id("has space"));
    }
}
