use crate::web_search::{WebSearchResponse, WebSearchSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, net::TcpListener, path::PathBuf, process::Stdio, sync::Mutex, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{path::BaseDirectory, AppHandle, Manager, State};
use tokio::process::{Child, Command};

const STARTUP_TIMEOUT_SECONDS: u64 = 35;
const REQUEST_TIMEOUT_SECONDS: u64 = 30;
const MAX_RESULTS: usize = 100;
const MAX_RAW_CONTENT_CHARS: usize = 1_000_000;

pub struct SearxngState(Mutex<Option<SearxngRuntime>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearxngLocalStatus {
    schema_version: u8,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    startup_timeout_seconds: u64,
    request_timeout_seconds: u64,
}

struct SearxngRuntime {
    port: u16,
    child: Child,
}

impl SearxngState {
    pub fn new() -> Self { Self(Mutex::new(None)) }
}

#[derive(Deserialize)]
pub struct SearxngSearchRequest {
    pub query: String,
    #[serde(rename = "maxResults")]
    pub max_results: Option<usize>,
}

fn query(request: &SearxngSearchRequest) -> Result<&str, &'static str> {
    let value = request.query.trim();
    if value.is_empty() || value.chars().count() > 2_000 { return Err("searxng-query-invalid"); }
    Ok(value)
}

fn available_port() -> Result<u16, &'static str> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "searxng-port-unavailable")?;
    listener.local_addr().map(|address| address.port()).map_err(|_| "searxng-port-unavailable")
}

fn resource_directory(app: &AppHandle) -> Result<PathBuf, &'static str> {
    let path = app.path().resolve("research/searxng", BaseDirectory::Resource).map_err(|_| "searxng-resource-unavailable")?;
    path.join("searx").is_dir().then_some(path).ok_or("searxng-resource-unavailable")
}

fn python_executable(app: &AppHandle) -> PathBuf {
    let bundled = app.path().resolve("research/python-runtime/python.exe", BaseDirectory::Resource).ok();
    bundled.filter(|path| path.is_file()).unwrap_or_else(|| PathBuf::from(if cfg!(target_os = "windows") { "python.exe" } else { "python3" }))
}

fn runtime_directory(app: &AppHandle) -> Result<PathBuf, &'static str> {
    let directory = app.path().app_data_dir().map_err(|_| "searxng-runtime-directory-unavailable")?.join("searxng");
    fs::create_dir_all(&directory).map_err(|_| "searxng-runtime-directory-unavailable")?;
    Ok(directory)
}

fn write_settings(app: &AppHandle, port: u16) -> Result<PathBuf, &'static str> {
    let directory = runtime_directory(app)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "searxng-settings-unavailable")?.as_nanos();
    let secret = format!("ai-work-os-{}-{}", std::process::id(), nonce);
    let settings = format!("use_default_settings: true\nserver:\n  bind_address: \\\"127.0.0.1\\\"\n  port: {}\n  secret_key: \\\"{}\\\"\n  limiter: false\n  image_proxy: false\nsearch:\n  formats:\n    - html\n    - json\n", port, secret);
    let path = directory.join("settings.yml");
    fs::write(&path, settings).map_err(|_| "searxng-settings-unavailable")?;
    Ok(path)
}

fn local_url(port: u16, path: &str) -> String { format!("http://127.0.0.1:{}{}", port, path) }

fn loopback_headers() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("X-Forwarded-For", reqwest::header::HeaderValue::from_static("127.0.0.1"));
    headers.insert("X-Real-IP", reqwest::header::HeaderValue::from_static("127.0.0.1"));
    headers
}

async fn wait_until_ready(port: u16) -> Result<(), &'static str> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|_| "searxng-unavailable")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(STARTUP_TIMEOUT_SECONDS);
    while tokio::time::Instant::now() < deadline {
        if let Ok(response) = client.get(local_url(port, "/")).headers(loopback_headers()).send().await {
            if response.status().is_success() { return Ok(()); }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("searxng-start-timeout")
}

fn running_port(state: &SearxngState) -> Result<Option<u16>, &'static str> {
    let mut current = state.0.lock().map_err(|_| "searxng-state-unavailable")?;
    let Some(runtime) = current.as_mut() else { return Ok(None); };
    match runtime.child.try_wait() {
        Ok(None) => Ok(Some(runtime.port)),
        Ok(Some(_)) | Err(_) => { *current = None; Ok(None) }
    }
}

pub(crate) fn status(state: &SearxngState) -> Result<SearxngLocalStatus, &'static str> {
    let port = running_port(state)?;
    Ok(SearxngLocalStatus {
        schema_version: 1,
        state: if port.is_some() { "running" } else { "not-started" },
        port,
        startup_timeout_seconds: STARTUP_TIMEOUT_SECONDS,
        request_timeout_seconds: REQUEST_TIMEOUT_SECONDS,
    })
}

async fn ensure_running(app: &AppHandle, state: &SearxngState) -> Result<u16, &'static str> {
    if let Some(port) = running_port(state)? { return Ok(port); }
    let source = resource_directory(app)?;
    let port = available_port()?;
    let settings = write_settings(app, port)?;
    let python = python_executable(app);
    {
        let mut current = state.0.lock().map_err(|_| "searxng-state-unavailable")?;
        if let Some(runtime_port) = current.as_mut().and_then(|runtime| runtime.child.try_wait().ok().and_then(|status| status.is_none().then_some(runtime.port))) {
            return Ok(runtime_port);
        }
        let mut command = Command::new(python);
        command
            .arg("-m")
            .arg("searx.webapp")
            .current_dir(&source)
            .env("SEARXNG_SETTINGS_PATH", settings)
            .env("PYTHONPATH", &source)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // CREATE_NO_WINDOW：Windows 上运行内嵌 Python 服务不应弹出外部 cmd/终端窗口。
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        let child = command.spawn().map_err(|_| "searxng-python-unavailable")?;
        *current = Some(SearxngRuntime { port, child });
    }
    if let Err(error) = wait_until_ready(port).await {
        let _ = stop_runtime(state).await;
        return Err(error);
    }
    Ok(port)
}

async fn stop_runtime(state: &SearxngState) -> Result<(), &'static str> {
    let runtime = state.0.lock().map_err(|_| "searxng-state-unavailable")?.take();
    if let Some(mut runtime) = runtime { runtime.child.kill().await.map_err(|_| "searxng-stop-failed")?; }
    Ok(())
}

fn text(value: &Value, name: &str) -> String { value.get(name).and_then(Value::as_str).unwrap_or_default().trim().to_owned() }

fn response_from_json(query: String, value: Value, max_results: usize) -> Result<WebSearchResponse, &'static str> {
    let results = value.get("results").and_then(Value::as_array).ok_or("searxng-response-invalid")?;
    let mut sources = Vec::new();
    let mut raw_content = String::new();
    for result in results.iter().take(max_results) {
        let url = text(result, "url");
        if !url.starts_with("https://") && !url.starts_with("http://") { continue; }
        let title = text(result, "title");
        let content = text(result, "content");
        let segment = format!("\n\n标题：{}\nURL：{}\n正文：{}", if title.is_empty() { "未命名结果" } else { &title }, url, content);
        if raw_content.chars().count() + segment.chars().count() > MAX_RAW_CONTENT_CHARS { break; }
        raw_content.push_str(&segment);
        sources.push(WebSearchSource { title: if title.is_empty() { "SearXNG 搜索来源".to_owned() } else { title }, url });
    }
    if raw_content.trim().is_empty() { return Err("searxng-no-results"); }
    Ok(WebSearchResponse { query, summary: format!("本地 SearXNG 返回 {} 个来源。", sources.len()), raw_content, sources })
}

pub async fn search_searxng_local_impl(app: &AppHandle, state: &SearxngState, request: SearxngSearchRequest) -> Result<WebSearchResponse, &'static str> {
    let normalized_query = query(&request)?.to_owned();
    let max_results = request.max_results.unwrap_or(MAX_RESULTS).clamp(1, MAX_RESULTS);
    let port = ensure_running(app, state).await?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS)).build().map_err(|_| "searxng-unavailable")?;
    let response = client.get(local_url(port, "/search")).headers(loopback_headers()).query(&[("q", normalized_query.as_str()), ("format", "json")]).send().await.map_err(|_| "searxng-request-failed")?;
    if !response.status().is_success() { return Err("searxng-request-rejected"); }
    let value = response.json::<Value>().await.map_err(|_| "searxng-response-invalid")?;
    response_from_json(normalized_query, value, max_results)
}

#[tauri::command]
pub async fn search_searxng_local(app: AppHandle, state: State<'_, SearxngState>, request: SearxngSearchRequest) -> Result<WebSearchResponse, &'static str> {
    search_searxng_local_impl(&app, &state, request).await
}

#[tauri::command]
pub async fn stop_searxng_local(state: State<'_, SearxngState>) -> Result<(), &'static str> { stop_runtime(&state).await }

/// Returns state without starting Python or accessing the network, for the local diagnostics report.
#[tauri::command]
pub fn searxng_local_status(state: State<'_, SearxngState>) -> Result<SearxngLocalStatus, &'static str> { status(&state) }

#[cfg(test)]
mod tests {
    use super::response_from_json;
    use serde_json::json;

    #[test]
    fn projects_json_results_without_inventing_sources() {
        let response = response_from_json("AI Work OS".to_owned(), json!({ "results": [{ "title": "Example", "url": "https://example.com/post", "content": "可读正文" }] }), 8).expect("valid response");
        assert_eq!(response.sources.len(), 1);
        assert!(response.raw_content.contains("https://example.com/post"));
    }

    #[test]
    fn loopback_requests_identify_the_local_caller_for_searxng_request_handling() {
        let headers = super::loopback_headers();
        assert_eq!(headers.get("X-Forwarded-For").and_then(|value| value.to_str().ok()), Some("127.0.0.1"));
        assert_eq!(headers.get("X-Real-IP").and_then(|value| value.to_str().ok()), Some("127.0.0.1"));
    }

    #[test]
    fn local_status_does_not_start_a_runtime() {
        let state = super::SearxngState::new();
        let status = super::status(&state).expect("status");
        assert_eq!(status.state, "not-started");
        assert_eq!(status.port, None);
        assert_eq!(status.startup_timeout_seconds, 35);
    }
}
