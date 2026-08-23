use crate::{last30days, searxng_local, web_search};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use tauri::AppHandle;

const MAX_CONTEXT_CHARS: usize = 1_000_000;
const MAX_SOURCES: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridSearchRequest {
    pub query: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridSearchSource {
    pub backend: String,
    pub title: String,
    pub url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridBackendReceipt {
    pub backend: String,
    pub state: &'static str,
    pub detail: String,
    pub source_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridSearchResponse {
    pub query: String,
    pub raw_content: String,
    pub sources: Vec<HybridSearchSource>,
    pub receipts: Vec<HybridBackendReceipt>,
}

fn validate_query(query: &str) -> Result<&str, &'static str> {
    let value = query.trim();
    if value.is_empty() || value.chars().count() > 2_000 {
        return Err("hybrid-search-query-invalid");
    }
    Ok(value)
}

fn canonical_url(url: &str) -> String {
    let without_fragment = url.split('#').next().unwrap_or(url).trim();
    let (base, query) = without_fragment.split_once('?').unwrap_or((without_fragment, ""));
    let normalized_base = if let Some((scheme, rest)) = base.split_once("://") {
        format!("{}://{}", scheme.to_ascii_lowercase(), rest.to_ascii_lowercase())
    } else {
        base.to_ascii_lowercase()
    };
    let retained = query.split('&').filter(|item| {
        let name = item.split('=').next().unwrap_or("").to_ascii_lowercase();
        !item.is_empty() && !name.starts_with("utm_") && !matches!(name.as_str(), "gclid" | "fbclid" | "mc_cid" | "mc_eid")
    }).collect::<Vec<_>>();
    if retained.is_empty() { normalized_base } else { format!("{}?{}", normalized_base, retained.join("&")) }
}

fn append_context(target: &mut String, backend: &str, body: &str, omitted: &mut usize) {
    if target.chars().count() >= MAX_CONTEXT_CHARS {
        *omitted += 1;
        return;
    }
    let segment = format!("\n\n===== 混合检索后端：{} =====\n{}", backend, body);
    let remaining = MAX_CONTEXT_CHARS.saturating_sub(target.chars().count());
    let segment_length = segment.chars().count();
    if segment_length <= remaining {
        target.push_str(&segment);
    } else {
        target.extend(segment.chars().take(remaining));
        *omitted += 1;
    }
}

fn push_sources(target: &mut Vec<HybridSearchSource>, seen: &mut BTreeSet<String>, backend: &str, sources: impl IntoIterator<Item = (String, String)>) {
    for (title, url) in sources {
        if target.len() >= MAX_SOURCES { break; }
        let canonical = canonical_url(&url);
        if canonical.is_empty() || !seen.insert(canonical) { continue; }
        target.push(HybridSearchSource { backend: backend.to_owned(), title, url });
    }
}

fn receipt(backend: &str, result: &Result<usize, &'static str>) -> HybridBackendReceipt {
    match result {
        Ok(source_count) => HybridBackendReceipt { backend: backend.to_owned(), state: "succeeded", detail: "已返回原始研究内容和来源。".to_owned(), source_count: *source_count },
        Err(error) => HybridBackendReceipt { backend: backend.to_owned(), state: "failed", detail: (*error).to_owned(), source_count: 0 },
    }
}

#[tauri::command]
pub async fn search_hybrid(app: AppHandle, state: tauri::State<'_, searxng_local::SearxngState>, request: HybridSearchRequest) -> Result<HybridSearchResponse, &'static str> {
    let query = validate_query(&request.query)?.to_owned();
    let exa = web_search::search_web(web_search::WebSearchRequest { query: query.clone(), max_results: Some(MAX_SOURCES) });
    let international = last30days::run_last30days_research(app.clone(), last30days::Last30DaysRequest { query: query.clone(), mode: last30days::Last30DaysMode::Last30days });
    let chinese = last30days::run_last30days_research(app.clone(), last30days::Last30DaysRequest { query: query.clone(), mode: last30days::Last30DaysMode::Last30daysCn });
    let searxng = searxng_local::search_searxng_local_impl(&app, &state, searxng_local::SearxngSearchRequest { query: query.clone(), max_results: Some(MAX_SOURCES) });
    let (exa_result, international_result, chinese_result, searxng_result) = tokio::join!(exa, international, chinese, searxng);

    let mut raw_content = String::new();
    let mut sources = Vec::new();
    let mut seen_urls = BTreeSet::new();
    let mut omitted_segments = 0;
    let exa_count = match &exa_result {
        Ok(result) => {
            append_context(&mut raw_content, "exa", &result.raw_content, &mut omitted_segments);
            push_sources(&mut sources, &mut seen_urls, "exa", result.sources.iter().map(|source| (source.title.clone(), source.url.clone())));
            Ok(result.sources.len())
        }
        Err(error) => Err(*error),
    };
    let international_count = match &international_result {
        Ok(result) => {
            append_context(&mut raw_content, "last30days", &result.raw_content, &mut omitted_segments);
            push_sources(&mut sources, &mut seen_urls, "last30days", result.sources.iter().map(|source| (source.title.clone(), source.url.clone())));
            Ok(result.sources.len())
        }
        Err(error) => Err(*error),
    };
    let chinese_count = match &chinese_result {
        Ok(result) => {
            append_context(&mut raw_content, "last30days-cn", &result.raw_content, &mut omitted_segments);
            push_sources(&mut sources, &mut seen_urls, "last30days-cn", result.sources.iter().map(|source| (source.title.clone(), source.url.clone())));
            Ok(result.sources.len())
        }
        Err(error) => Err(*error),
    };
    let searxng_count = match &searxng_result {
        Ok(result) => {
            append_context(&mut raw_content, "searxng-local", &result.raw_content, &mut omitted_segments);
            push_sources(&mut sources, &mut seen_urls, "searxng-local", result.sources.iter().map(|source| (source.title.clone(), source.url.clone())));
            Ok(result.sources.len())
        }
        Err(error) => Err(*error),
    };
    let receipts = vec![receipt("exa", &exa_count), receipt("last30days", &international_count), receipt("last30days-cn", &chinese_count), receipt("searxng-local", &searxng_count)];
    if raw_content.trim().is_empty() {
        return Err("hybrid-search-no-results");
    }
    if omitted_segments > 0 {
        raw_content.push_str(&format!("\n\n[上下文预算说明：{} 个后端结果片段因当前 1M 字符 Provider 请求预算未完整装入；其后端回执会在聊天中保留。]", omitted_segments));
    }
    Ok(HybridSearchResponse { query, raw_content, sources, receipts })
}

#[cfg(test)]
mod tests {
    use super::{canonical_url, push_sources, BTreeSet, MAX_SOURCES};

    #[test]
    fn removes_tracking_parameters_and_deduplicates_sources() {
        assert_eq!(canonical_url("https://Example.com/Post?utm_source=x&tag=ai#top"), "https://example.com/post?tag=ai");
        let mut sources = Vec::new();
        let mut seen = BTreeSet::new();
        push_sources(&mut sources, &mut seen, "exa", [("A".to_owned(), "https://example.com/post?utm_source=x".to_owned())]);
        push_sources(&mut sources, &mut seen, "last30days", [("B".to_owned(), "https://example.com/post".to_owned())]);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].backend, "exa");
    }

    #[test]
    fn retains_up_to_one_hundred_deduplicated_sources() {
        let mut sources = Vec::new();
        let mut seen = BTreeSet::new();
        push_sources(&mut sources, &mut seen, "exa", (0..(MAX_SOURCES + 5)).map(|index| (format!("source-{index}"), format!("https://example.com/{index}"))));
        assert_eq!(sources.len(), MAX_SOURCES);
        assert_eq!(sources.last().map(|source| source.url.as_str()), Some("https://example.com/99"));
    }
}
