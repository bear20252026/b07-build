use reqwest::{header::{ACCEPT, CONTENT_TYPE}, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;
use tokio::task::JoinSet;

const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const MAX_RESULTS: usize = 100;
const MAX_PARALLEL_PAGE_FETCHES: usize = 8;
const MAX_RAW_CONTENT_BYTES: usize = 1_000_000;

#[derive(Deserialize)]
pub struct WebSearchRequest {
    pub query: String,
    #[serde(rename = "maxResults")]
    pub max_results: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchSource { pub title: String, pub url: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub query: String,
    pub summary: String,
    pub raw_content: String,
    pub sources: Vec<WebSearchSource>,
}

fn validate_query(query: &str) -> Result<&str, &'static str> {
    let normalized = query.trim();
    if normalized.is_empty() || normalized.len() > 2_000 { return Err("web-search-query-invalid"); }
    Ok(normalized)
}

fn result_text(body: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(content) = value.pointer("/result/content").and_then(Value::as_array) {
            let text = content.iter().filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n\n");
            if !text.trim().is_empty() { return Some(text); }
        }
    }
    for line in body.lines() {
        let Some(raw) = line.strip_prefix("data:") else { continue; };
        let Ok(value) = serde_json::from_str::<Value>(raw.trim()) else { continue; };
        let Some(content) = value.pointer("/result/content").and_then(Value::as_array) else { continue; };
        let text = content.iter().filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n\n");
        if !text.trim().is_empty() { return Some(text); }
    }
    None
}

fn sources_from_text(text: &str) -> Vec<WebSearchSource> {
    let mut urls = BTreeSet::new();
    for token in text.split_whitespace() {
        let url = token.trim_matches(|character: char| matches!(character, '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.' | ';' | '"' | '\''));
        if url.starts_with("https://") || url.starts_with("http://") { urls.insert(url.to_owned()); }
    }
    urls.into_iter().take(MAX_RESULTS).enumerate().map(|(index, url)| WebSearchSource { title: format!("搜索来源 {}", index + 1), url }).collect()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes { return value; }
    let mut boundary = 0;
    for (index, _) in value.char_indices() { if index > max_bytes { break; } boundary = index; }
    &value[..boundary]
}

fn readable_page_text(body: &str) -> String {
    let mut output = String::with_capacity(body.len().min(200_000));
    let mut in_tag = false;
    let mut previous_space = false;
    for character in body.chars() {
        match character {
            '<' => { in_tag = true; if !previous_space { output.push('\n'); previous_space = true; } }
            '>' => in_tag = false,
            _ if in_tag => {},
            _ if character.is_whitespace() => { if !previous_space { output.push(' '); previous_space = true; } }
            _ => { output.push(character); previous_space = false; },
        }
        if output.len() >= 200_000 { break; }
    }
    output.trim().to_owned()
}

async fn fetch_source_text(client: &Client, source: &WebSearchSource) -> Option<String> {
    let response = client.get(&source.url).header(ACCEPT, "text/html, text/plain;q=0.9").send().await.ok()?;
    if !response.status().is_success() { return None; }
    let bytes = response.bytes().await.ok()?;
    let text = readable_page_text(&String::from_utf8_lossy(&bytes));
    (!text.is_empty()).then_some(text)
}

fn mcp_initialize_payload() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "AI Work OS", "version": "0.1" } }
    })
}

#[tauri::command]
pub async fn search_web(request: WebSearchRequest) -> Result<WebSearchResponse, &'static str> {
    let query = validate_query(&request.query)?;
    let max_results = request.max_results.unwrap_or(MAX_RESULTS).clamp(1, MAX_RESULTS);
    let client = Client::builder().timeout(Duration::from_secs(20)).user_agent("AI-Work-OS/0.1 WebSearch").build().map_err(|_| "web-search-unavailable")?;
    let initialized = client.post(EXA_MCP_URL).header(ACCEPT, "application/json, text/event-stream").header(CONTENT_TYPE, "application/json").header("mcp-protocol-version", "2025-03-26").json(&mcp_initialize_payload()).send().await.map_err(|_| "web-search-network-failed")?;
    if !initialized.status().is_success() { return Err("web-search-request-rejected"); }
    let session_id = initialized.headers().get("mcp-session-id").and_then(|value| value.to_str().ok()).map(str::to_owned);
    let initialized_notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let mut notification = client.post(EXA_MCP_URL).header(ACCEPT, "application/json, text/event-stream").header(CONTENT_TYPE, "application/json").header("mcp-protocol-version", "2025-03-26").json(&initialized_notification);
    if let Some(session_id) = &session_id { notification = notification.header("mcp-session-id", session_id); }
    let notification_response = notification.send().await.map_err(|_| "web-search-network-failed")?;
    if !notification_response.status().is_success() { return Err("web-search-request-rejected"); }
    let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "web_search_exa", "arguments": { "query": query, "numResults": max_results } } });
    let mut call = client.post(EXA_MCP_URL).header(ACCEPT, "application/json, text/event-stream").header(CONTENT_TYPE, "application/json").header("mcp-protocol-version", "2025-03-26").json(&payload);
    if let Some(session_id) = session_id { call = call.header("mcp-session-id", session_id); }
    let response = call.send().await.map_err(|_| "web-search-network-failed")?;
    if !response.status().is_success() { return Err(if response.status().as_u16() == 429 { "web-search-rate-limited" } else { "web-search-request-rejected" }); }
    let body = response.text().await.map_err(|_| "web-search-response-invalid")?;
    let tool_text = result_text(&body).ok_or("web-search-no-results")?;
    let sources = sources_from_text(&tool_text);
    let mut raw_content = String::new();
    let mut pending_sources = sources.iter().cloned();
    let mut page_fetches = JoinSet::new();
    for source in pending_sources.by_ref().take(MAX_PARALLEL_PAGE_FETCHES) {
        let page_client = client.clone();
        page_fetches.spawn(async move {
            let page_text = fetch_source_text(&page_client, &source).await;
            (source, page_text)
        });
    }
    while let Some(result) = page_fetches.join_next().await {
        if let Ok((source, Some(page_text))) = result {
            if raw_content.len() < MAX_RAW_CONTENT_BYTES {
                let remaining = MAX_RAW_CONTENT_BYTES.saturating_sub(raw_content.len());
                raw_content.push_str(&format!("\n\n===== 原始网页：{}\nURL: {}\n=====\n{}", source.title, source.url, truncate_utf8(&page_text, remaining)));
            }
        }
        if raw_content.len() >= MAX_RAW_CONTENT_BYTES { page_fetches.abort_all(); break; }
        if let Some(source) = pending_sources.next() {
            let page_client = client.clone();
            page_fetches.spawn(async move {
                let page_text = fetch_source_text(&page_client, &source).await;
                (source, page_text)
            });
        }
    }
    if raw_content.trim().is_empty() { raw_content = tool_text.clone(); }
    let summary = raw_content.clone();
    Ok(WebSearchResponse { query: query.to_owned(), summary, raw_content, sources })
}

#[cfg(test)]
mod tests {
    use super::{readable_page_text, result_text, sources_from_text, truncate_utf8, validate_query, MAX_RESULTS};
    #[test]
    fn parses_mcp_sse_content_without_inventing_sources() {
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"A https://example.com/doc\"},{\"type\":\"text\",\"text\":\"B https://example.org\"}]}}\n";
        let text = result_text(sse).expect("MCP content"); let sources = sources_from_text(&text);
        assert_eq!(sources.len(), 2); assert_eq!(sources[0].url, "https://example.com/doc");
    }
    #[test]
    fn keeps_up_to_one_hundred_distinct_sources() {
        let text = (0..120).map(|index| format!("https://example.com/{index}")).collect::<Vec<_>>().join(" ");
        assert_eq!(sources_from_text(&text).len(), MAX_RESULTS);
    }
    #[test]
    fn parses_json_rpc_content_when_remote_server_does_not_stream() { assert_eq!(result_text(r#"{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"内容"}]}}"#), Some("内容".to_owned())); }
    #[test]
    fn retains_readable_text_and_never_splits_utf8() { assert_eq!(readable_page_text("<h1>标题</h1><p>正文</p>"), "标题\n正文"); assert_eq!(truncate_utf8("你好世界", 5), "你"); }
    #[test]
    fn rejects_blank_or_excessive_queries() { assert!(validate_query(" ").is_err()); assert!(validate_query(&"a".repeat(2_001)).is_err()); }
}
