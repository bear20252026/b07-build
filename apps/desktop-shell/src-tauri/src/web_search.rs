use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;

const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const MAX_RESULTS: usize = 8;

#[derive(Deserialize)]
pub struct WebSearchRequest {
    pub query: String,
    #[serde(rename = "maxResults")]
    pub max_results: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchSource {
    pub title: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub query: String,
    pub summary: String,
    pub sources: Vec<WebSearchSource>,
}

fn validate_query(query: &str) -> Result<&str, &'static str> {
    let normalized = query.trim();
    if normalized.is_empty() || normalized.len() > 2_000 { return Err("web-search-query-invalid"); }
    Ok(normalized)
}

fn result_text(body: &str) -> Option<String> {
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

#[tauri::command]
pub async fn search_web(request: WebSearchRequest) -> Result<WebSearchResponse, &'static str> {
    let query = validate_query(&request.query)?;
    let max_results = request.max_results.unwrap_or(5).clamp(1, MAX_RESULTS);
    let client = Client::builder().timeout(Duration::from_secs(25)).user_agent("AI-Work-OS/0.1 WebSearch").build().map_err(|_| "web-search-unavailable")?;
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "web_search_exa", "arguments": { "query": query, "numResults": max_results } }
    });
    let response = client.post(EXA_MCP_URL).header("accept", "application/json, text/event-stream").json(&payload).send().await.map_err(|_| "web-search-network-failed")?;
    if !response.status().is_success() {
        return Err(if response.status().as_u16() == 429 { "web-search-rate-limited" } else { "web-search-request-rejected" });
    }
    let body = response.text().await.map_err(|_| "web-search-response-invalid")?;
    let summary = result_text(&body).ok_or("web-search-no-results")?;
    Ok(WebSearchResponse { query: query.to_owned(), sources: sources_from_text(&summary), summary })
}

#[cfg(test)]
mod tests {
    use super::{result_text, sources_from_text, validate_query};

    #[test]
    fn parses_mcp_sse_content_without_inventing_sources() {
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"A https://example.com/doc\"},{\"type\":\"text\",\"text\":\"B https://example.org\"}]}}\n";
        let text = result_text(sse).expect("MCP content");
        assert!(text.contains("example.com"));
        let sources = sources_from_text(&text);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].url, "https://example.com/doc");
    }

    #[test]
    fn rejects_blank_or_excessive_queries() {
        assert!(validate_query(" ").is_err());
        assert!(validate_query(&"a".repeat(2_001)).is_err());
        assert_eq!(validate_query(" valid ").unwrap(), "valid");
    }
}
