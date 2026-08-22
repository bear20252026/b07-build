use std::{collections::HashMap, sync::Mutex};

use reqwest::{header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE}, Client};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone)]
struct DirectProviderSession {
    provider_id: String,
    protocol: DirectProviderProtocol,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DirectProviderProtocol {
    OpenaiCompatible,
    AnthropicCompatible,
}

#[derive(Deserialize)]
pub struct ConfigureDirectProviderRequest {
    pub provider_id: String,
    pub protocol: DirectProviderProtocol,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Deserialize)]
pub struct DiscoverDirectProviderRequest {
    pub provider_id: String,
}

#[derive(Serialize)]
pub struct DirectProviderModelDiscovery {
    schema_version: u8,
    provider_id: String,
    models: Vec<String>,
}

#[derive(Deserialize)]
pub struct StartDirectProviderStreamRequest {
    pub provider_id: String,
    pub prompt: String,
    pub model: Option<String>,
    pub request_id: String,
}

#[derive(Serialize)]
pub struct DirectProviderStatus {
    schema_version: u8,
    provider_id: String,
    model: String,
    protocol: &'static str,
    connected: bool,
    can_read_secret: bool,
}

#[derive(Clone, Serialize)]
struct DirectProviderStreamEvent {
    request_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub struct DirectProviderState(Mutex<HashMap<String, DirectProviderSession>>);

impl DirectProviderState {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

fn require_identifier(value: &str, field: &'static str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 128 || !value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-')) {
        return Err(field);
    }
    Ok(())
}

fn require_nonempty(value: &str, field: &'static str, max: usize) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.len() > max {
        return Err(field);
    }
    Ok(())
}

fn model_list_url_for(session: &DirectProviderSession) -> String {
    let base = session.base_url.trim_end_matches('/');
    match session.protocol {
        DirectProviderProtocol::OpenaiCompatible => {
            let base = base.strip_suffix("/v1").unwrap_or(base);
            format!("{base}/v1/models")
        }
        DirectProviderProtocol::AnthropicCompatible => format!("{base}/v1/models"),
    }
}

fn url_for(session: &DirectProviderSession) -> String {
    let base = session.base_url.trim_end_matches('/');
    match session.protocol {
        DirectProviderProtocol::OpenaiCompatible => {
            let base = base.strip_suffix("/v1").unwrap_or(base);
            format!("{base}/v1/chat/completions")
        }
        DirectProviderProtocol::AnthropicCompatible => format!("{base}/v1/messages"),
    }
}

fn headers_for(session: &DirectProviderSession) -> Result<HeaderMap, &'static str> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    let is_mimo = session.provider_id == "mimo" || session.provider_id.starts_with("mimo-token-plan-");
    match session.protocol {
        DirectProviderProtocol::OpenaiCompatible if is_mimo => {
            headers.insert("api-key", HeaderValue::from_str(&session.api_key).map_err(|_| "api-key-invalid")?);
        }
        DirectProviderProtocol::OpenaiCompatible => {
            headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {}", session.api_key)).map_err(|_| "api-key-invalid")?);
        }
        DirectProviderProtocol::AnthropicCompatible if is_mimo => {
            headers.insert("api-key", HeaderValue::from_str(&session.api_key).map_err(|_| "api-key-invalid")?);
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        DirectProviderProtocol::AnthropicCompatible => {
            headers.insert("x-api-key", HeaderValue::from_str(&session.api_key).map_err(|_| "api-key-invalid")?);
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
    }
    Ok(headers)
}

fn payload_for(session: &DirectProviderSession, model: &str, prompt: &str) -> serde_json::Value {
    match session.protocol {
        DirectProviderProtocol::OpenaiCompatible => serde_json::json!({
            "model": model,
            "stream": true,
            "messages": [{ "role": "user", "content": prompt }]
        }),
        DirectProviderProtocol::AnthropicCompatible => serde_json::json!({
            "model": model,
            "stream": true,
            "max_tokens": 4096,
            "messages": [{ "role": "user", "content": prompt }]
        }),
    }
}

fn text_from_sse(protocol: DirectProviderProtocol, data: &str) -> Option<String> {
    if data == "[DONE]" { return None; }
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    match protocol {
        DirectProviderProtocol::OpenaiCompatible => value.pointer("/choices/0/delta/content").and_then(|value| value.as_str()).map(str::to_owned),
        DirectProviderProtocol::AnthropicCompatible => value.pointer("/delta/text").and_then(|value| value.as_str()).map(str::to_owned),
    }
}

fn emit(app: &AppHandle, event: DirectProviderStreamEvent) {
    let _ = app.emit("direct-provider-stream", event);
}

#[tauri::command]
pub fn configure_direct_provider(
    state: State<'_, DirectProviderState>,
    request: ConfigureDirectProviderRequest,
) -> Result<DirectProviderStatus, &'static str> {
    require_identifier(&request.provider_id, "provider-id-invalid")?;
    require_nonempty(&request.base_url, "base-url-invalid", 2_048)?;
    require_nonempty(&request.model, "model-invalid", 128)?;
    require_nonempty(&request.api_key, "api-key-invalid", 1_024)?;
    let session = DirectProviderSession {
        provider_id: request.provider_id.clone(), protocol: request.protocol,
        base_url: request.base_url.trim().to_owned(), model: request.model.trim().to_owned(), api_key: request.api_key,
    };
    state.0.lock().map_err(|_| "provider-state-unavailable")?.insert(request.provider_id.clone(), session.clone());
    Ok(DirectProviderStatus {
        schema_version: 1, provider_id: request.provider_id, model: session.model,
        protocol: match session.protocol { DirectProviderProtocol::OpenaiCompatible => "openai-compatible", DirectProviderProtocol::AnthropicCompatible => "anthropic-compatible" },
        connected: true, can_read_secret: false,
    })
}

#[tauri::command]
pub async fn discover_direct_provider(
    state: State<'_, DirectProviderState>,
    request: DiscoverDirectProviderRequest,
) -> Result<DirectProviderModelDiscovery, &'static str> {
    require_identifier(&request.provider_id, "provider-id-invalid")?;
    let session = state.0.lock().map_err(|_| "provider-state-unavailable")?.get(&request.provider_id).cloned().ok_or("provider-not-connected")?;
    let response = Client::new().get(model_list_url_for(&session)).headers(headers_for(&session)?).send().await.map_err(|_| "provider-request-failed")?;
    if !response.status().is_success() { return Err("provider-model-list-failed"); }
    let payload: serde_json::Value = response.json().await.map_err(|_| "provider-model-list-invalid")?;
    let mut models = payload.get("data").and_then(|value| value.as_array()).into_iter().flatten()
        .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
        .filter(|id| !id.is_empty() && id.len() <= 128 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-')))
        .map(str::to_owned).collect::<Vec<_>>();
    models.sort(); models.dedup(); models.truncate(100);
    Ok(DirectProviderModelDiscovery { schema_version: 1, provider_id: request.provider_id, models })
}

#[tauri::command]
pub fn start_direct_provider_stream(
    app: AppHandle,
    state: State<'_, DirectProviderState>,
    request: StartDirectProviderStreamRequest,
) -> Result<(), &'static str> {
    require_identifier(&request.provider_id, "provider-id-invalid")?;
    require_identifier(&request.request_id, "request-id-invalid")?;
    require_nonempty(&request.prompt, "prompt-invalid", 24_000)?;
    let session = state.0.lock().map_err(|_| "provider-state-unavailable")?.get(&request.provider_id).cloned().ok_or("provider-not-connected")?;
    let model = request.model.unwrap_or(session.model.clone());
    require_nonempty(&model, "model-invalid", 128)?;
    tauri::async_runtime::spawn(async move {
        let client = Client::new();
        let response = client.post(url_for(&session)).headers(match headers_for(&session) { Ok(headers) => headers, Err(message) => { emit(&app, DirectProviderStreamEvent { request_id: request.request_id, kind: "error", text: None, model: None, message: Some(message.to_owned()) }); return; } }).json(&payload_for(&session, &model, &request.prompt)).send().await;
        let Ok(mut response) = response else { emit(&app, DirectProviderStreamEvent { request_id: request.request_id, kind: "error", text: None, model: None, message: Some("provider-request-failed".to_owned()) }); return; };
        if !response.status().is_success() { emit(&app, DirectProviderStreamEvent { request_id: request.request_id, kind: "error", text: None, model: None, message: Some(format!("provider-http-{}", response.status().as_u16())) }); return; }
        let mut buffer = String::new();
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(end) = buffer.find('\n') {
                        let line = buffer[..end].trim_end_matches('\r').to_owned();
                        buffer.drain(..=end);
                        if let Some(data) = line.strip_prefix("data:") {
                            if let Some(text) = text_from_sse(session.protocol, data.trim()) {
                                emit(&app, DirectProviderStreamEvent { request_id: request.request_id.clone(), kind: "text", text: Some(text), model: Some(model.clone()), message: None });
                            }
                        }
                    }
                }
                Ok(None) => { emit(&app, DirectProviderStreamEvent { request_id: request.request_id, kind: "done", text: None, model: Some(model), message: None }); return; }
                Err(_) => { emit(&app, DirectProviderStreamEvent { request_id: request.request_id, kind: "error", text: None, model: None, message: Some("provider-stream-failed".to_owned()) }); return; }
            }
        }
    });
    Ok(())
}
