//! 已安装插件的**只读**目录，供 `plugin-reference` 生成"这个插件提供什么"的提示。
//!
//! ## 数据从哪来
//!
//! 插件由 `tools/plugin-marketplace-cli.ts` 安装，落在
//! `$AWO_PLUGIN_MARKETPLACE_HOME`（默认 `~/.awo/plugin-marketplace`）下的 SQLite：
//!
//! - `plugin-marketplace.sqlite` → `plugin_installations(plugin_id, record_json)`
//! - `mcp-apps.sqlite` → `mcp_app_manifest_revisions(app_id, revision, manifest_json, …)`
//!
//! 两张表都只存 **id + JSON blob**，所以这里的活是"读两列 + 反序列化"，不是重写业务逻辑。
//! 这正是走 Rust 命令面而不是起 Node 进程的理由：数据是文件，读取不需要那个 18k 行的库。
//!
//! ## 三个刻意的选择
//!
//! 1. **只读打开。** `SQLITE_OPEN_READ_ONLY` —— 应用不该写插件的账本，写是 CLI 的事。
//! 2. **库不存在不算错误。** 没装过插件是正常状态，返回空列表。报错会让界面显示故障。
//! 3. **单条坏数据不拖垮整次读取。** 某一行 JSON 解析失败就跳过它，其余照常返回 ——
//!    否则一个手改坏的文件会让整个插件目录消失。

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::PathBuf;

/// 一条插件的对外视图。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PluginReferenceEntry {
    /// 稳定 id，形如 `name@marketplace`。`plugin-reference` 用它做去重与冲突判定。
    pub plugin_id: String,
    pub name: String,
    pub marketplace: String,
    pub version: String,
    /// 插件声明的 MCP App id（未声明时为 `None`）。
    pub app_id: Option<String>,
    /// 该 App 声明的 MCP server id（未声明或 App 清单缺失时为 `None`）。
    pub mcp_server_id: Option<String>,
    /// 该 App 请求的工具名。**声明值，不代表已连接或可用。**
    pub requested_tool_names: Vec<String>,
}

/// 数据目录：`AWO_PLUGIN_MARKETPLACE_HOME` 优先，否则 `~/.awo/plugin-marketplace`。
///
/// 与 CLI 保持同一套规则 —— 两边读的必须是同一份账本，否则会出现"CLI 装了但应用看不见"。
fn marketplace_home() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("AWO_PLUGIN_MARKETPLACE_HOME") {
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".awo").join("plugin-marketplace"))
}

/// 只读打开；文件不存在时返回 `None`（不是错误）。
fn open_readonly(path: &PathBuf) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

/// 从 `manifest_json` 里取 `serverId` 与 `requestedToolNames`。
///
/// 字段名用 camelCase：TS 侧写进去的就是这个形状。取不到就如实给空值，
/// 不猜、不补默认值 —— 编一个 server id 比没有更糟。
fn parse_app_manifest(manifest_json: &str) -> (Option<String>, Vec<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(manifest_json) else {
        return (None, Vec::new());
    };
    let server_id = value
        .get("serverId")
        .and_then(|item| item.as_str())
        .map(str::to_owned);
    let tools = value
        .get("requestedToolNames")
        .and_then(|item| item.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    (server_id, tools)
}

/// 把两段 JSON 合成一条目录条目。**纯函数**，故可单测。
///
/// 返回 `None` 表示这条安装记录不可用（不是合法 JSON，或缺了必需的 id/name）。
fn parse_entry(record_json: &str, app_manifest_json: Option<&str>) -> Option<PluginReferenceEntry> {
    let record: serde_json::Value = serde_json::from_str(record_json).ok()?;
    let plugin_id = record.get("id").and_then(|item| item.as_str())?.to_owned();
    let name = record.get("name").and_then(|item| item.as_str())?.to_owned();
    let marketplace = record
        .get("marketplace")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_owned();
    let version = record
        .get("version")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_owned();
    let app_id = record
        .get("appId")
        .and_then(|item| item.as_str())
        .map(str::to_owned);
    let (mcp_server_id, requested_tool_names) = app_manifest_json
        .map(parse_app_manifest)
        .unwrap_or((None, Vec::new()));
    Some(PluginReferenceEntry {
        plugin_id,
        name,
        marketplace,
        version,
        app_id,
        mcp_server_id,
        requested_tool_names,
    })
}

/// 读取已安装插件目录。
///
/// 只读、无网络、不启动任何进程。库不存在时返回空列表。
#[tauri::command]
pub fn plugin_reference_catalog() -> Result<Vec<PluginReferenceEntry>, &'static str> {
    let Some(home) = marketplace_home() else {
        // 连 home 目录都拿不到：这不是"没装插件"，而是环境异常，如实报错。
        return Err("plugin-catalog-home-unavailable");
    };

    let Some(plugins) = open_readonly(&home.join("plugin-marketplace.sqlite")) else {
        return Ok(Vec::new());
    };

    let mut statement = plugins
        .prepare("SELECT plugin_id, record_json FROM plugin_installations ORDER BY plugin_id")
        .map_err(|_| "plugin-catalog-query-failed")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "plugin-catalog-query-failed")?;

    // App 清单库是**可选**的：只装元数据（未声明 mcpApp）的插件照样要出现在目录里。
    let apps = open_readonly(&home.join("mcp-apps.sqlite"));

    let mut entries: Vec<PluginReferenceEntry> = Vec::new();
    for row in rows.flatten() {
        let (plugin_id, record_json) = row;
        // 取该 App 的**最新** revision。
        let manifest = apps.as_ref().and_then(|connection| {
            connection
                .query_row(
                    "SELECT manifest_json FROM mcp_app_manifest_revisions WHERE app_id = ?1 ORDER BY revision DESC LIMIT 1",
                    [&plugin_id],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        });
        let app_manifest = manifest.or_else(|| {
            // 安装记录里的 appId 才是权威；plugin_id 只是兜底（两者通常相同）。
            let record: serde_json::Value = serde_json::from_str(&record_json).ok()?;
            let app_id = record.get("appId").and_then(|item| item.as_str())?;
            apps.as_ref().and_then(|connection| {
                connection
                    .query_row(
                        "SELECT manifest_json FROM mcp_app_manifest_revisions WHERE app_id = ?1 ORDER BY revision DESC LIMIT 1",
                        [app_id],
                        |row| row.get::<_, String>(0),
                    )
                    .ok()
            })
        });
        // 坏行跳过，其余照常返回。
        if let Some(entry) = parse_entry(&record_json, app_manifest.as_deref()) {
            entries.push(entry);
        }
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORD: &str = r#"{"id":"hello@official","name":"hello","marketplace":"official","version":"1.2.0","rootPath":"/x","installedAt":"2026-10-01T00:00:00Z","appId":"hello-app"}"#;
    const MANIFEST: &str = r#"{"appId":"hello-app","serverId":"hello-server","htmlResourceUri":"ui://hello","requestedToolNames":["greet","wave"]}"#;

    #[test]
    fn 完整记录能解析出插件与能力() {
        let entry = parse_entry(RECORD, Some(MANIFEST)).expect("应能解析");
        assert_eq!(entry.plugin_id, "hello@official");
        assert_eq!(entry.name, "hello");
        assert_eq!(entry.marketplace, "official");
        assert_eq!(entry.version, "1.2.0");
        assert_eq!(entry.app_id.as_deref(), Some("hello-app"));
        assert_eq!(entry.mcp_server_id.as_deref(), Some("hello-server"));
        assert_eq!(entry.requested_tool_names, vec!["greet", "wave"]);
    }

    #[test]
    fn 没有app清单时能力为空而不是编一个() {
        // 编一个 server id 比没有更糟：调用方会拿它去比对"是否已连接"。
        let entry = parse_entry(RECORD, None).expect("应能解析");
        assert_eq!(entry.mcp_server_id, None);
        assert!(entry.requested_tool_names.is_empty());
    }

    #[test]
    fn 清单坏掉时降级为空能力() {
        let entry = parse_entry(RECORD, Some("not json")).expect("记录本身有效就该保留");
        assert_eq!(entry.mcp_server_id, None);
        assert!(entry.requested_tool_names.is_empty());
    }

    #[test]
    fn 缺id或name的记录被丢弃() {
        assert!(parse_entry(r#"{"name":"x"}"#, None).is_none());
        assert!(parse_entry(r#"{"id":"x"}"#, None).is_none());
        assert!(parse_entry("not json", None).is_none());
    }

    #[test]
    fn 只装元数据的插件也要出现() {
        // 未声明 mcpApp 的插件仍有 id/name，目录里应当能看到它（能力为空）。
        let entry = parse_entry(r#"{"id":"meta@official","name":"meta"}"#, None).expect("应能解析");
        assert_eq!(entry.plugin_id, "meta@official");
        assert_eq!(entry.app_id, None);
        assert_eq!(entry.marketplace, "");
    }

    #[test]
    fn 工具名里的非字符串被忽略() {
        let (_, tools) = parse_app_manifest(r#"{"requestedToolNames":["a",1,null,"b"]}"#);
        assert_eq!(tools, vec!["a", "b"]);
    }
}
