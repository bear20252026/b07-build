use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::time::Duration;
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::process::Command;

const MAX_QUERY_CHARS: usize = 2_000;
const MAX_RAW_CONTENT_CHARS: usize = 1_000_000;
const MAX_SOURCES: usize = 100;
const RESEARCH_TIMEOUT_SECONDS: u64 = 180;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Last30DaysRequest {
    pub query: String,
    pub mode: Last30DaysMode,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Last30DaysMode {
    Last30days,
    Last30daysCn,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Last30DaysSource {
    pub title: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Last30DaysResponse {
    pub query: String,
    pub mode: Last30DaysMode,
    pub raw_content: String,
    pub sources: Vec<Last30DaysSource>,
}

fn validated_query(query: &str) -> Result<&str, &'static str> {
    let value = query.trim();
    if value.is_empty() || value.chars().count() > MAX_QUERY_CHARS {
        return Err("last30days-query-invalid");
    }
    Ok(value)
}

fn source_script(app: &AppHandle, mode: &Last30DaysMode) -> Result<std::path::PathBuf, &'static str> {
    let path = match mode {
        Last30DaysMode::Last30days => "research/last30days-skill/skills/last30days/scripts/last30days.py",
        Last30DaysMode::Last30daysCn => "research/last30days-skill-cn/scripts/last30days.py",
    };
    let resolved = app.path().resolve(path, BaseDirectory::Resource).map_err(|_| "last30days-resource-unavailable")?;
    resolved.is_file().then_some(resolved).ok_or("last30days-resource-unavailable")
}

fn source_urls(raw: &str) -> Vec<Last30DaysSource> {
    let mut urls = BTreeSet::new();
    for token in raw.split_whitespace() {
        let url = token.trim_matches(|character: char| matches!(character, '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.' | ';' | '"' | '\''));
        if url.starts_with("https://") || url.starts_with("http://") {
            urls.insert(url.to_owned());
        }
    }
    urls.into_iter().take(MAX_SOURCES).enumerate().map(|(index, url)| Last30DaysSource { title: format!("近 30 天研究来源 {}", index + 1), url }).collect()
}

#[cfg(test)]
fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn python_executable(app: &AppHandle) -> std::path::PathBuf {
    let bundled = app.path().resolve("research/python-runtime/python.exe", BaseDirectory::Resource).ok();
    bundled.filter(|path| path.is_file()).unwrap_or_else(|| std::path::PathBuf::from(if cfg!(target_os = "windows") { "python.exe" } else { "python3" }))
}

#[tauri::command]
pub async fn run_last30days_research(app: AppHandle, request: Last30DaysRequest) -> Result<Last30DaysResponse, &'static str> {
    let query = validated_query(&request.query)?.to_owned();
    let script = source_script(&app, &request.mode)?;
    let executable = python_executable(&app);
    let mut command = Command::new(executable);
    command
        .arg(script)
        .arg(&query)
        .args(["--emit", "json"]);
    // CREATE_NO_WINDOW：Windows 中运行内嵌研究器不得显示独立 cmd/终端窗口。
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(
        Duration::from_secs(RESEARCH_TIMEOUT_SECONDS),
        command.output(),
    )
    .await
    .map_err(|_| "last30days-timeout")?
    .map_err(|_| "last30days-python-unavailable")?;
    if !output.status.success() {
        return Err("last30days-run-failed");
    }
    let raw_content = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if raw_content.is_empty() {
        return Err("last30days-empty-output");
    }
    if raw_content.chars().count() > MAX_RAW_CONTENT_CHARS {
        return Err("last30days-output-exceeds-context-budget");
    }
    let sources = source_urls(&raw_content);
    Ok(Last30DaysResponse { query, mode: request.mode, raw_content, sources })
}

#[cfg(test)]
mod tests {
    use super::{source_urls, truncate_chars, validated_query};

    #[test]
    fn extracts_public_sources_from_research_output() {
        let sources = source_urls("A https://example.com/a and B https://example.org/b.");
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].url, "https://example.com/a");
    }

    #[test]
    fn preserves_utf8_boundaries_and_validates_queries() {
        assert_eq!(truncate_chars("你好世界", 3), "你好世");
        assert!(validated_query(" ").is_err());
        assert!(validated_query(&"a".repeat(2_001)).is_err());
    }
}
