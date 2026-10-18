//! 用户显式登记的 MCP server 配置。
//!
//! ## 为什么是"用户填"而不是"插件声明"
//!
//! 插件只声明 `mcpApp.serverId`，没有 `command`/`args`。若让插件声明决定本机执行什么，
//! 等于把"装了别人的插件"升级成"跑了别人的命令"——那是另一套信任模型（谁能发布、
//! 如何审计、如何撤销），需要单独设计。
//!
//! 这里反过来：**执行的永远是用户自己填的命令**，插件只能按 `serverId` 引用。
//! 声明与配置的交集才有意义 —— 声明但未配置 = "未连接"，不是"可执行"。
//!
//! ## 三条纪律
//!
//! 1. **文件不存在是正常状态**（没配过 server），返回空列表，不报错。
//! 2. **文件损坏要报错**，不能静默当空 —— 否则用户会以为配置丢了，然后重新配一遍覆盖掉。
//! 3. **原子写**：先写临时文件再 rename，避免中途崩溃留下半个 JSON。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 一条 server 配置。字段名用 camelCase 与前端一致。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// 稳定标识，插件的 `serverId` 与它对齐才有意义。
    pub id: String,
    /// 可执行文件：PATH 命令名或绝对路径。
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// `[key, value]` 对，保持顺序。
    #[serde(default)]
    pub env: Vec<[String; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// 配置文件位置：`AWO_MCP_SERVERS_FILE` 优先，否则 `~/.awo/mcp-servers.json`。
fn config_path() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("AWO_MCP_SERVERS_FILE") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".awo").join("mcp-servers.json"))
}

/// 校验一条配置。**纯函数**，故可单测。
///
/// id 限制在 `[A-Za-z0-9._-]`：它会被用作日志与插件引用的键，含空格/冒号会让
/// "这个 server 是谁"变得有歧义。
fn validate(entry: &McpServerConfig) -> Result<(), &'static str> {
    if entry.id.trim().is_empty() {
        return Err("mcp-server-config-id-empty");
    }
    if !entry.id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')) {
        return Err("mcp-server-config-id-invalid");
    }
    if entry.command.trim().is_empty() {
        return Err("mcp-server-config-command-empty");
    }
    // env 的键不能空，否则子进程会收到一个无名变量。
    if entry.env.iter().any(|pair| pair[0].trim().is_empty()) {
        return Err("mcp-server-config-env-key-empty");
    }
    Ok(())
}

/// 从磁盘读配置。文件不存在 → 空；内容损坏 → 错误。
fn read_configs_from(path: &Path) -> Result<Vec<McpServerConfig>, &'static str> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path).map_err(|_| "mcp-server-config-unreadable")?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<McpServerConfig> = serde_json::from_str(&text).map_err(|_| "mcp-server-config-corrupt")?;
    Ok(parsed)
}

/// 原子写：先写同目录临时文件，再 rename 覆盖。
fn write_configs_to(path: &Path, entries: &[McpServerConfig]) -> Result<(), &'static str> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "mcp-server-config-unwritable")?;
    }
    let text = serde_json::to_string_pretty(entries).map_err(|_| "mcp-server-config-unwritable")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|_| "mcp-server-config-unwritable")?;
    std::fs::rename(&temp, path).map_err(|_| "mcp-server-config-unwritable")?;
    Ok(())
}

/// upsert：同 id 覆盖，其余保持原序。**纯函数**。
fn upsert(entries: &mut Vec<McpServerConfig>, entry: McpServerConfig) {
    match entries.iter_mut().find(|item| item.id == entry.id) {
        Some(existing) => *existing = entry,
        None => entries.push(entry),
    }
    entries.sort_by(|left, right| left.id.cmp(&right.id));
}

fn resolve_path() -> Result<PathBuf, &'static str> {
    config_path().ok_or("mcp-server-config-home-unavailable")
}

/// 列出用户登记的 server（含 `enabled=false` 的）。
#[tauri::command]
pub fn mcp_server_config_list() -> Result<Vec<McpServerConfig>, &'static str> {
    read_configs_from(&resolve_path()?)
}

/// 新增或更新一条配置，返回保存后的全量列表。
#[tauri::command]
pub fn mcp_server_config_save(entry: McpServerConfig) -> Result<Vec<McpServerConfig>, &'static str> {
    validate(&entry)?;
    let path = resolve_path()?;
    let mut entries = read_configs_from(&path)?;
    upsert(&mut entries, entry);
    write_configs_to(&path, &entries)?;
    Ok(entries)
}

/// 删除一条配置，返回剩余列表。删不存在的 id 不报错（幂等）。
#[tauri::command]
pub fn mcp_server_config_remove(id: String) -> Result<Vec<McpServerConfig>, &'static str> {
    let path = resolve_path()?;
    let mut entries = read_configs_from(&path)?;
    entries.retain(|item| item.id != id);
    write_configs_to(&path, &entries)?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, command: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.to_owned(),
            command: command.to_owned(),
            args: Vec::new(),
            env: Vec::new(),
            working_directory: None,
            enabled: true,
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("b07-mcp-config-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("临时目录");
        dir.join("mcp-servers.json")
    }

    #[test]
    fn 校验拒绝空id与空命令() {
        assert_eq!(validate(&entry("", "node")), Err("mcp-server-config-id-empty"));
        assert_eq!(validate(&entry("ok", "   ")), Err("mcp-server-config-command-empty"));
    }

    #[test]
    fn 校验拒绝含空格的id() {
        // id 会被用作日志与插件引用的键，含空格/冒号会让"这个 server 是谁"变得有歧义。
        assert_eq!(validate(&entry("my server", "node")), Err("mcp-server-config-id-invalid"));
        assert_eq!(validate(&entry("my:server", "node")), Err("mcp-server-config-id-invalid"));
        assert!(validate(&entry("my-server_1.2", "node")).is_ok());
    }

    #[test]
    fn 校验拒绝空env键() {
        let mut config = entry("ok", "node");
        config.env = vec![[String::new(), "x".to_owned()]];
        assert_eq!(validate(&config), Err("mcp-server-config-env-key-empty"));
    }

    #[test]
    fn 文件不存在时返回空列表() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        assert!(read_configs_from(&path).expect("不该报错").is_empty());
    }

    #[test]
    fn 文件损坏时报错而不是当空() {
        // 静默当空会让用户以为配置丢了，然后重配一遍覆盖掉原文件。
        let path = temp_path("corrupt");
        std::fs::write(&path, "{ 这不是 JSON").expect("写坏文件");
        assert_eq!(read_configs_from(&path), Err("mcp-server-config-corrupt"));
    }

    #[test]
    fn 写入后可读回且顺序稳定() {
        let path = temp_path("roundtrip");
        let mut entries = vec![entry("b", "node"), entry("a", "node")];
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        write_configs_to(&path, &entries).expect("写");
        let read = read_configs_from(&path).expect("读");
        assert_eq!(read, entries);
        assert_eq!(read[0].id, "a");
    }

    #[test]
    fn upsert覆盖同id且保持排序() {
        let mut entries = vec![entry("a", "old"), entry("b", "node")];
        upsert(&mut entries, entry("a", "new"));
        assert_eq!(entries.len(), 2, "不得重复插入");
        assert_eq!(entries[0].command, "new");
        upsert(&mut entries, entry("c", "node"));
        assert_eq!(entries.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }

    #[test]
    fn enabled缺省为true() {
        let parsed: McpServerConfig = serde_json::from_str(r#"{"id":"x","command":"node"}"#).expect("解析");
        assert!(parsed.enabled);
        assert!(parsed.args.is_empty());
    }
}
