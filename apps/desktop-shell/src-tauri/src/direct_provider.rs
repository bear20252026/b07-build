use std::{collections::HashMap, sync::Mutex};

use std::time::Duration;

use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Client,
};
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
#[serde(rename_all = "camelCase")]
pub struct ConfigureDirectProviderRequest {
    pub provider_id: String,
    pub protocol: DirectProviderProtocol,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverDirectProviderRequest {
    pub provider_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProviderModelDiscovery {
    schema_version: u8,
    provider_id: String,
    models: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDirectProviderStreamRequest {
    pub provider_id: String,
    pub messages: Vec<DirectProviderMessage>,
    pub model: Option<String>,
    pub request_id: String,
    /// 工具声明。仅 OpenAI-compatible 协议会真正下发；Anthropic-compatible 一律忽略，
    /// 行为与传空完全一致（稳妥版：先把一条协议的闭环跑通，再谈第二种）。
    #[serde(default)]
    pub tools: Vec<DirectProviderTool>,
}

/// 一个可调用工具的声明，parameters 直接透传 JSON Schema。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProviderTool {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Clone, Deserialize, Default)]
pub struct DirectProviderMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<DirectProviderImage>,
    /// role = "tool" 时必填：对应哪一次工具调用。
    #[serde(default)]
    pub tool_call_id: Option<String>,
    /// role = "assistant" 且该轮发起过工具调用时，原样回传上游的 tool_calls 数组，
    /// 否则模型在下一轮看不到自己调用过什么。
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
}

/// 一次完整的工具调用。arguments 是流式片段拼接出来的原始 JSON 文本，不做提前解析：
/// 上游经常把 arguments 切成任意边界的碎片，边收边 parse 只会得到一堆假失败。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProviderToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 流式 tool_calls 的一个增量片段。
#[derive(Clone, PartialEq, Eq, Debug)]
struct ToolCallDelta {
    index: usize,
    id: Option<String>,
    name: Option<String>,
    arguments: Option<String>,
}

/// 按 index 累加流式工具调用，最后产出完整列表。
#[derive(Default)]
struct ToolCallAccumulator {
    calls: Vec<DirectProviderToolCall>,
}

impl ToolCallAccumulator {
    /// 返回 Some(工具名) 表示这是一次新调用的第一个片段，调用方可以据此提示“正在调用 X”。
    /// 若首个片段还没带上名字（少数上游会先只发 index/id），这里返回 None，后续片段也不会补报。
    fn apply(&mut self, delta: ToolCallDelta) -> Option<String> {
        while self.calls.len() <= delta.index {
            self.calls.push(DirectProviderToolCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
        }
        let call = &mut self.calls[delta.index];
        let is_new = call.id.is_empty() && call.name.is_empty();
        if let Some(id) = delta.id {
            call.id = id;
        }
        if let Some(name) = delta.name {
            call.name = name;
        }
        if let Some(arguments) = delta.arguments {
            call.arguments.push_str(&arguments);
        }
        if is_new && !self.calls[delta.index].name.is_empty() {
            Some(self.calls[delta.index].name.clone())
        } else {
            None
        }
    }

    /// 非流式路径：整条 message 里一次性给出的调用。
    fn push_complete(&mut self, call: DirectProviderToolCall) {
        self.calls.push(call);
    }

    /// 丢弃没有名字的占位（上游偶尔会发一个只有 index 的空片段）。
    fn finish(self) -> Vec<DirectProviderToolCall> {
        self.calls
            .into_iter()
            .filter(|call| !call.name.is_empty())
            .collect()
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProviderImage {
    pub media_type: String,
    pub base64_data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectProviderStatus {
    schema_version: u8,
    provider_id: String,
    model: String,
    protocol: &'static str,
    connected: bool,
    can_read_secret: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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

pub(crate) fn connected_provider_count(state: &DirectProviderState) -> Result<usize, &'static str> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "provider-state-unavailable")?
        .len())
}

fn require_identifier(value: &str, field: &'static str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
    {
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
            if session.provider_id == "longcat" || base.contains("longcat.chat/openai") {
                let root = base.split("/openai").next().unwrap_or(base);
                return format!("{root}/v1/models");
            }
            if base_has_explicit_api_version(base) {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            }
        }
        DirectProviderProtocol::AnthropicCompatible => format!("{base}/v1/models"),
    }
}

fn base_has_explicit_api_version(base: &str) -> bool {
    base.rsplit('/')
        .next()
        .map(|segment| {
            matches!(
                segment.to_ascii_lowercase().as_str(),
                "v1" | "v2" | "v3" | "v4" | "v1beta"
            )
        })
        .unwrap_or(false)
}

fn url_for(session: &DirectProviderSession) -> String {
    let base = session.base_url.trim_end_matches('/');
    match session.protocol {
        DirectProviderProtocol::OpenaiCompatible => {
            if base_has_explicit_api_version(base) {
                format!("{base}/chat/completions")
            } else {
                format!("{base}/v1/chat/completions")
            }
        }
        DirectProviderProtocol::AnthropicCompatible => format!("{base}/v1/messages"),
    }
}

fn is_mimo_session(session: &DirectProviderSession) -> bool {
    session.provider_id == "mimo"
        || session.provider_id.starts_with("mimo-token-plan-")
        || session.api_key.trim_start().starts_with("tp-")
        || session
            .base_url
            .to_ascii_lowercase()
            .contains("xiaomimimo.com")
}

fn headers_for(session: &DirectProviderSession) -> Result<HeaderMap, &'static str> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    // MiMo Token Plan's official `tp-` keys use `api-key` regardless of whether the
    // user selected the preset or supplied the same official endpoint as a custom Provider.
    let is_mimo = is_mimo_session(session);
    match session.protocol {
        DirectProviderProtocol::OpenaiCompatible if is_mimo => {
            headers.insert(
                "api-key",
                HeaderValue::from_str(&session.api_key).map_err(|_| "api-key-invalid")?,
            );
        }
        DirectProviderProtocol::OpenaiCompatible => {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", session.api_key))
                    .map_err(|_| "api-key-invalid")?,
            );
        }
        DirectProviderProtocol::AnthropicCompatible if is_mimo => {
            headers.insert(
                "api-key",
                HeaderValue::from_str(&session.api_key).map_err(|_| "api-key-invalid")?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        DirectProviderProtocol::AnthropicCompatible => {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(&session.api_key).map_err(|_| "api-key-invalid")?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
    }
    Ok(headers)
}

fn network_error_code_from_parts(
    is_timeout: bool,
    is_connect: bool,
    is_request: bool,
    detail: &str,
) -> &'static str {
    if is_timeout {
        return "provider-request-timeout";
    }
    if is_connect {
        let detail = detail.to_ascii_lowercase();
        if detail.contains("dns")
            || detail.contains("getaddrinfo")
            || detail.contains("name or service")
            || detail.contains("no such host")
        {
            return "provider-dns-failed";
        }
        if detail.contains("tls")
            || detail.contains("ssl")
            || detail.contains("certificate")
            || detail.contains("rustls")
        {
            return "provider-tls-failed";
        }
        return "provider-connect-failed";
    }
    if is_request {
        return "provider-request-invalid";
    }
    "provider-request-failed"
}

/// Returns a stable local error code only. The reqwest error text may contain a URL and is never
/// emitted to the WebView, diagnostic report, log, Provider context or chat timeline.
fn network_error_code(error: &reqwest::Error) -> &'static str {
    network_error_code_from_parts(
        error.is_timeout(),
        error.is_connect(),
        error.is_request(),
        &error.to_string(),
    )
}

/// Converts the Windows `ProxyServer` registry value into a reqwest-compatible URL without
/// returning it to the WebView, diagnostics, log, Provider context or chat timeline.
/// Windows uses either one bare proxy for every scheme or `http=…;https=…` entries.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_proxy_url_from_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut http = None;
    let mut https = None;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((scheme, endpoint)) = part.split_once('=') {
            match scheme.trim().to_ascii_lowercase().as_str() {
                "https" => https = Some(endpoint.trim()),
                "http" => http = Some(endpoint.trim()),
                _ => {}
            }
        }
    }
    let selected = https.or(http).unwrap_or(raw).trim();
    if selected.is_empty() {
        return None;
    }
    Some(if selected.contains("://") {
        selected.to_owned()
    } else {
        format!("http://{selected}")
    })
}

#[cfg(target_os = "windows")]
fn windows_system_https_proxy() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let internet_settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = internet_settings.get_value("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return None;
    }
    let server: String = internet_settings.get_value("ProxyServer").ok()?;
    windows_proxy_url_from_server(&server)
}

/// 探测与真实聊天共享同一网络策略。默认 reqwest 总超时会把慢首 token 的
/// 长上下文流误判为“服务未响应”；使用明确的长请求期限并限制建立连接时间。
/// On Windows, mirror the static system proxy used by browser/curl-native traffic. This is a
/// direct HTTPS client setting, not a local HTTP gateway or a request relay.
fn provider_http_client() -> Result<Client, &'static str> {
    let builder = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20 * 60));
    #[cfg(target_os = "windows")]
    let builder = {
        let mut builder = builder;
        if let Some(proxy_url) = windows_system_https_proxy() {
            if let Ok(proxy) = reqwest::Proxy::https(&proxy_url) {
                builder = builder.proxy(proxy);
            }
        }
        builder
    };
    builder.build().map_err(|_| "provider-client-unavailable")
}

fn validate_messages(messages: &[DirectProviderMessage]) -> Result<(), &'static str> {
    if messages.is_empty() || messages.len() > 200 {
        return Err("messages-invalid");
    }
    let mut length = 0usize;
    for message in messages {
        match message.role.as_str() {
            // 发起工具调用的那轮 assistant 消息通常一个字都没有，只有 tool_calls。
            // 强行要求正文会逼上层编一句占位话塞进历史，那才是污染上下文。
            "assistant" if message.tool_calls.is_some() => {
                if message.content.len() > 1_000_000 {
                    return Err("message-content-invalid");
                }
            }
            "user" | "assistant" => {
                require_nonempty(&message.content, "message-content-invalid", 1_000_000)?
            }
            // 工具结果允许是空字符串：列目录可能真的一个文件都没有，这不是错误。
            "tool" => {
                let has_call_id = message
                    .tool_call_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .is_some();
                if !has_call_id {
                    return Err("message-tool-call-id-invalid");
                }
                if message.content.len() > 1_000_000 {
                    return Err("message-content-invalid");
                }
            }
            _ => return Err("message-role-invalid"),
        }
        length = length.saturating_add(message.content.len());
        if length > 1_000_000 {
            return Err("messages-too-large");
        }
        if message.images.len() > 8
            || message.images.iter().any(|image| {
                !matches!(
                    image.media_type.as_str(),
                    "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/bmp"
                ) || image.base64_data.is_empty()
                    || image.base64_data.len() > 50 * 1024 * 1024
            })
        {
            return Err("message-images-invalid");
        }
    }
    Ok(())
}

fn payload_for(
    session: &DirectProviderSession,
    model: &str,
    messages: &[DirectProviderMessage],
    tools: &[DirectProviderTool],
) -> serde_json::Value {
    let messages = messages.iter().map(|message| {
        // 工具结果必须带上 call id，否则上游无法把它对回某一次调用。
        if message.role == "tool" {
            return serde_json::json!({
                "role": "tool",
                "tool_call_id": message.tool_call_id,
                "content": message.content
            });
        }
        let base = if message.images.is_empty() {
            serde_json::json!({ "role": message.role, "content": message.content })
        } else {
            match session.protocol {
                DirectProviderProtocol::OpenaiCompatible => {
                    let mut content = vec![serde_json::json!({ "type": "text", "text": message.content })];
                    content.extend(message.images.iter().map(|image| serde_json::json!({ "type": "image_url", "image_url": { "url": format!("data:{};base64,{}", image.media_type, image.base64_data) } })));
                    serde_json::json!({ "role": message.role, "content": content })
                }
                DirectProviderProtocol::AnthropicCompatible => {
                    let mut content = vec![serde_json::json!({ "type": "text", "text": message.content })];
                    content.extend(message.images.iter().map(|image| serde_json::json!({ "type": "image", "source": { "type": "base64", "media_type": image.media_type, "data": image.base64_data } })));
                    serde_json::json!({ "role": message.role, "content": content })
                }
            }
        };
        // 把上一轮 assistant 的调用原样带回，模型才知道自己已经问过什么。
        match (&message.tool_calls, message.role.as_str()) {
            (Some(calls), "assistant") => {
                let mut carried = base;
                carried["tool_calls"] = calls.clone();
                carried
            }
            _ => base,
        }
    }).collect::<Vec<_>>();
    match session.protocol {
        DirectProviderProtocol::OpenaiCompatible => {
            let mut payload = serde_json::json!({
                "model": model,
                "stream": true,
                "messages": messages
            });
            if !tools.is_empty() {
                payload["tools"] = serde_json::json!(tools
                    .iter()
                    .map(|tool| serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters
                        }
                    }))
                    .collect::<Vec<_>>());
            }
            payload
        }
        // 稳妥版：Anthropic-compatible 一律不下发 tools，行为与不传完全一致。
        DirectProviderProtocol::AnthropicCompatible => serde_json::json!({
            "model": model,
            "stream": true,
            "max_tokens": 4096,
            "messages": messages
        }),
    }
}

fn deltas_from_sse(protocol: DirectProviderProtocol, data: &str) -> Vec<(&'static str, String)> {
    if data == "[DONE]" {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return Vec::new();
    };
    let mut deltas = Vec::new();
    match protocol {
        DirectProviderProtocol::OpenaiCompatible => {
            if let Some(text) = value
                .pointer("/choices/0/delta/content")
                .and_then(|value| value.as_str())
                .filter(|text| !text.is_empty())
            {
                deltas.push(("text", text.to_owned()));
            }
            if let Some(reasoning) = value
                .pointer("/choices/0/delta/reasoning_content")
                .or_else(|| value.pointer("/choices/0/delta/reasoning"))
                .and_then(|value| value.as_str())
                .filter(|text| !text.is_empty())
            {
                deltas.push(("reasoning", reasoning.to_owned()));
            }
        }
        DirectProviderProtocol::AnthropicCompatible => {
            if let Some(text) = value
                .pointer("/delta/text")
                .and_then(|value| value.as_str())
                .filter(|text| !text.is_empty())
            {
                deltas.push(("text", text.to_owned()));
            }
            if let Some(reasoning) = value
                .pointer("/delta/thinking")
                .and_then(|value| value.as_str())
                .filter(|text| !text.is_empty())
            {
                deltas.push(("reasoning", reasoning.to_owned()));
            }
        }
    }
    deltas
}

/// 从一条 SSE data 里取出流式 tool_calls 增量。
///
/// 只有 OpenAI-compatible 会产生结果；Anthropic-compatible 恒为空向量，这样它在工具
/// 调用这件事上的行为和改动前完全一致。
fn tool_call_deltas_from_sse(protocol: DirectProviderProtocol, data: &str) -> Vec<ToolCallDelta> {
    let mut deltas = Vec::new();
    let DirectProviderProtocol::OpenaiCompatible = protocol else {
        return deltas;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return deltas;
    };
    let Some(calls) = value
        .pointer("/choices/0/delta/tool_calls")
        .and_then(|value| value.as_array())
    else {
        return deltas;
    };
    for call in calls {
        let index = call
            .get("index")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as usize;
        let function = call.get("function");
        let id = call
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let name = function
            .and_then(|value| value.get("name"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let arguments = function
            .and_then(|value| value.get("arguments"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        // 什么都拿不到的空片段直接丢掉，别制造一个没有名字的调用。
        if id.is_none() && name.is_none() && arguments.is_none() {
            continue;
        }
        deltas.push(ToolCallDelta {
            index,
            id,
            name,
            arguments,
        });
    }
    deltas
}

/// 部分兼容层不流式下发 tool_calls，而是在整条 message 里一次性给出。
fn tool_calls_from_message(
    protocol: DirectProviderProtocol,
    data: &str,
) -> Vec<DirectProviderToolCall> {
    let DirectProviderProtocol::OpenaiCompatible = protocol else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return Vec::new();
    };
    let Some(calls) = value
        .pointer("/choices/0/message/tool_calls")
        .and_then(|value| value.as_array())
    else {
        return Vec::new();
    };
    calls
        .iter()
        .filter_map(|call| {
            let name = call
                .pointer("/function/name")
                .and_then(|value| value.as_str())?
                .to_owned();
            Some(DirectProviderToolCall {
                id: call
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_owned(),
                name,
                arguments: call
                    .pointer("/function/arguments")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
        .collect()
}

fn error_from_sse(data: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(data).ok()?;
    let message = value
        .pointer("/error/message")
        .or_else(|| value.pointer("/message"))
        .and_then(|item| item.as_str())?
        .trim();
    if message.is_empty() {
        return None;
    }
    // 不将可能包含 HTML、密钥或超长调试信息的上游负载直接放入聊天时间线。
    let compact = message
        .chars()
        .filter(|character| !character.is_control())
        .take(360)
        .collect::<String>();
    (!compact.is_empty()).then_some(compact)
}

fn http_error_message(
    status: reqwest::StatusCode,
    body: &str,
    includes_images: bool,
    session: &DirectProviderSession,
    model: &str,
) -> String {
    if status.as_u16() == 404 && includes_images {
        if is_mimo_session(session) && model.eq_ignore_ascii_case("mimo-v2.5-pro") {
            return "provider-http-404-image-mimo-v25-pro".to_owned();
        }
        return "provider-http-404-image: 当前 Base URL、协议或模型未接受图片内容；请改用供应商支持视觉的模型或核对兼容端点".to_owned();
    }
    let upstream = error_from_sse(body).unwrap_or_default();
    if upstream.is_empty() {
        format!("provider-http-{}", status.as_u16())
    } else {
        format!("provider-http-{}: {}", status.as_u16(), upstream)
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
        provider_id: request.provider_id.clone(),
        protocol: request.protocol,
        base_url: request.base_url.trim().to_owned(),
        model: request.model.trim().to_owned(),
        api_key: request.api_key,
    };
    state
        .0
        .lock()
        .map_err(|_| "provider-state-unavailable")?
        .insert(request.provider_id.clone(), session.clone());
    Ok(DirectProviderStatus {
        schema_version: 1,
        provider_id: request.provider_id,
        model: session.model,
        protocol: match session.protocol {
            DirectProviderProtocol::OpenaiCompatible => "openai-compatible",
            DirectProviderProtocol::AnthropicCompatible => "anthropic-compatible",
        },
        connected: true,
        can_read_secret: false,
    })
}

#[tauri::command]
pub async fn discover_direct_provider(
    state: State<'_, DirectProviderState>,
    request: DiscoverDirectProviderRequest,
) -> Result<DirectProviderModelDiscovery, &'static str> {
    require_identifier(&request.provider_id, "provider-id-invalid")?;
    let session = state
        .0
        .lock()
        .map_err(|_| "provider-state-unavailable")?
        .get(&request.provider_id)
        .cloned()
        .ok_or("provider-not-connected")?;
    let mut headers = headers_for(&session)?;
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    let response = provider_http_client()?
        .get(model_list_url_for(&session))
        .headers(headers)
        .send()
        .await
        .map_err(|error| network_error_code(&error))?;
    // `/models` is optional in OpenAI-compatible services. A subscription gateway may return an
    // HTML page, a vendor-specific payload, or 404 while normal chat inference remains available.
    // Return an empty catalog so the UI preserves the user's manually supplied model identifier.
    if !response.status().is_success() {
        return Ok(DirectProviderModelDiscovery {
            schema_version: 1,
            provider_id: request.provider_id,
            models: Vec::new(),
        });
    }
    let payload: serde_json::Value = match response.json().await {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(DirectProviderModelDiscovery {
                schema_version: 1,
                provider_id: request.provider_id,
                models: Vec::new(),
            })
        }
    };
    let mut models = payload
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id.chars().all(|ch| {
                    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-' | '/')
                })
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models.truncate(100);
    Ok(DirectProviderModelDiscovery {
        schema_version: 1,
        provider_id: request.provider_id,
        models,
    })
}

#[tauri::command]
pub async fn probe_direct_provider(
    state: State<'_, DirectProviderState>,
    request: DiscoverDirectProviderRequest,
) -> Result<(), &'static str> {
    require_identifier(&request.provider_id, "provider-id-invalid")?;
    let session = state
        .0
        .lock()
        .map_err(|_| "provider-state-unavailable")?
        .get(&request.provider_id)
        .cloned()
        .ok_or("provider-not-connected")?;
    let probe_messages = vec![DirectProviderMessage {
        role: "user".to_owned(),
        content: "Reply with OK.".to_owned(),
        images: Vec::new(),
        ..Default::default()
    }];
    let response = provider_http_client()?
        .post(url_for(&session))
        .headers(headers_for(&session)?)
        .json(&payload_for(&session, &session.model, &probe_messages, &[]))
        .send()
        .await
        .map_err(|error| network_error_code(&error))?;
    if response.status().is_success() {
        return Ok(());
    }
    match response.status().as_u16() {
        401 => Err("provider-http-401"),
        403 => Err("provider-http-403"),
        429 => Err("provider-http-429"),
        _ => Err("provider-request-rejected"),
    }
}

#[tauri::command]
pub fn start_direct_provider_stream(
    app: AppHandle,
    state: State<'_, DirectProviderState>,
    request: StartDirectProviderStreamRequest,
) -> Result<(), &'static str> {
    require_identifier(&request.provider_id, "provider-id-invalid")?;
    require_identifier(&request.request_id, "request-id-invalid")?;
    validate_messages(&request.messages)?;
    let session = state
        .0
        .lock()
        .map_err(|_| "provider-state-unavailable")?
        .get(&request.provider_id)
        .cloned()
        .ok_or("provider-not-connected")?;
    let model = request.model.unwrap_or(session.model.clone());
    require_nonempty(&model, "model-invalid", 128)?;
    tauri::async_runtime::spawn(async move {
        let client = match provider_http_client() {
            Ok(client) => client,
            Err(message) => {
                emit(
                    &app,
                    DirectProviderStreamEvent {
                        request_id: request.request_id,
                        kind: "error",
                        text: None,
                        model: None,
                        message: Some(message.to_owned()),
                    },
                );
                return;
            }
        };
        let response = client
            .post(url_for(&session))
            .headers(match headers_for(&session) {
                Ok(headers) => headers,
                Err(message) => {
                    emit(
                        &app,
                        DirectProviderStreamEvent {
                            request_id: request.request_id,
                            kind: "error",
                            text: None,
                            model: None,
                            message: Some(message.to_owned()),
                        },
                    );
                    return;
                }
            })
            .json(&payload_for(
                &session,
                &model,
                &request.messages,
                &request.tools,
            ))
            .send()
            .await;
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                emit(
                    &app,
                    DirectProviderStreamEvent {
                        request_id: request.request_id,
                        kind: "error",
                        text: None,
                        model: None,
                        message: Some(network_error_code(&error).to_owned()),
                    },
                );
                return;
            }
        };
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let includes_images = request
                .messages
                .iter()
                .any(|message| !message.images.is_empty());
            emit(
                &app,
                DirectProviderStreamEvent {
                    request_id: request.request_id,
                    kind: "error",
                    text: None,
                    model: Some(model.clone()),
                    message: Some(http_error_message(
                        status,
                        &body,
                        includes_images,
                        &session,
                        &model,
                    )),
                },
            );
            return;
        }
        let mut buffer = String::new();
        let mut tool_calls = ToolCallAccumulator::default();
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(end) = buffer.find('\n') {
                        let line = buffer[..end].trim_end_matches('\r').to_owned();
                        buffer.drain(..=end);
                        if let Some(data) = line.strip_prefix("data:") {
                            let data = data.trim();
                            if let Some(message) = error_from_sse(data) {
                                emit(
                                    &app,
                                    DirectProviderStreamEvent {
                                        request_id: request.request_id,
                                        kind: "error",
                                        text: None,
                                        model: Some(model.clone()),
                                        message: Some(format!("provider-sse-error: {message}")),
                                    },
                                );
                                return;
                            }
                            for (kind, text) in deltas_from_sse(session.protocol, data) {
                                emit(
                                    &app,
                                    DirectProviderStreamEvent {
                                        request_id: request.request_id.clone(),
                                        kind,
                                        text: Some(text),
                                        model: Some(model.clone()),
                                        message: None,
                                    },
                                );
                            }
                            // 工具调用增量：按 index 累加，arguments 是会被切成任意边界的碎片，
                            // 必须整段拼完再交给上层，不能边收边 parse。
                            for delta in tool_call_deltas_from_sse(session.protocol, data) {
                                if let Some(name) = tool_calls.apply(delta) {
                                    emit(
                                        &app,
                                        DirectProviderStreamEvent {
                                            request_id: request.request_id.clone(),
                                            kind: "tool-call-start",
                                            text: Some(name),
                                            model: Some(model.clone()),
                                            message: None,
                                        },
                                    );
                                }
                            }
                            for call in tool_calls_from_message(session.protocol, data) {
                                let name = call.name.clone();
                                tool_calls.push_complete(call);
                                emit(
                                    &app,
                                    DirectProviderStreamEvent {
                                        request_id: request.request_id.clone(),
                                        kind: "tool-call-start",
                                        text: Some(name),
                                        model: Some(model.clone()),
                                        message: None,
                                    },
                                );
                            }
                        }
                    }
                }
                Ok(None) => {
                    // 流结束时一次性交付完整调用列表：上层拿到后才去执行工具，再把结果
                    // 以 role="tool" 的消息发回来，由上层决定要不要继续下一轮。
                    let calls = tool_calls.finish();
                    if !calls.is_empty() {
                        if let Ok(serialized) = serde_json::to_string(&calls) {
                            emit(
                                &app,
                                DirectProviderStreamEvent {
                                    request_id: request.request_id.clone(),
                                    kind: "tool-calls",
                                    text: None,
                                    model: Some(model.clone()),
                                    message: Some(serialized),
                                },
                            );
                        }
                    }
                    emit(
                        &app,
                        DirectProviderStreamEvent {
                            request_id: request.request_id,
                            kind: "done",
                            text: None,
                            model: Some(model),
                            message: None,
                        },
                    );
                    return;
                }
                Err(error) => {
                    emit(
                        &app,
                        DirectProviderStreamEvent {
                            request_id: request.request_id,
                            kind: "error",
                            text: None,
                            model: None,
                            message: Some(network_error_code(&error).to_owned()),
                        },
                    );
                    return;
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        deltas_from_sse, payload_for, tool_call_deltas_from_sse, tool_calls_from_message,
        validate_messages, DirectProviderImage, DirectProviderMessage, DirectProviderProtocol,
        DirectProviderSession, DirectProviderTool, ToolCallAccumulator, ToolCallDelta,
    };

    fn session_with(protocol: DirectProviderProtocol) -> DirectProviderSession {
        DirectProviderSession {
            provider_id: "provider".to_owned(),
            protocol,
            base_url: "https://example.invalid".to_owned(),
            model: "model".to_owned(),
            api_key: "key".to_owned(),
        }
    }

    fn message(role: &str, content: &str) -> DirectProviderMessage {
        DirectProviderMessage {
            role: role.to_owned(),
            content: content.to_owned(),
            images: Vec::new(),
            tool_call_id: None,
            tool_calls: None,
        }
    }

    #[test]
    fn accumulates_streamed_tool_call_fragments_in_order() {
        let mut accumulator = ToolCallAccumulator::default();
        assert_eq!(
            accumulator.apply(ToolCallDelta {
                index: 0,
                id: Some("call-1".to_owned()),
                name: Some("read_file".to_owned()),
                arguments: None,
            }),
            Some("read_file".to_owned())
        );
        assert_eq!(
            accumulator.apply(ToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments: Some("{\"path\":".to_owned())
            }),
            None
        );
        accumulator.apply(ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments: Some("\"src/main.rs\"}".to_owned()),
        });
        let calls = accumulator.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, "{\"path\":\"src/main.rs\"}");
    }

    #[test]
    fn parses_openai_tool_call_deltas_and_ignores_empty_fragments() {
        let deltas = tool_call_deltas_from_sse(
            DirectProviderProtocol::OpenaiCompatible,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-9","type":"function","function":{"name":"list_files","arguments":"{}"}}]}}]}"#,
        );
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].index, 0);
        assert_eq!(deltas[0].name.as_deref(), Some("list_files"));
        let empty = tool_call_deltas_from_sse(
            DirectProviderProtocol::OpenaiCompatible,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}"#,
        );
        assert!(empty.is_empty());
    }

    #[test]
    fn anthropic_compatible_never_emits_tool_calls() {
        let data = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"x","arguments":"{}"}}]}}]}"#;
        assert!(
            tool_call_deltas_from_sse(DirectProviderProtocol::AnthropicCompatible, data).is_empty()
        );
        assert!(
            tool_calls_from_message(DirectProviderProtocol::AnthropicCompatible, data).is_empty()
        );
    }

    #[test]
    fn reads_tool_calls_delivered_whole_in_the_final_message() {
        let calls = tool_calls_from_message(
            DirectProviderProtocol::OpenaiCompatible,
            r#"{"choices":[{"message":{"tool_calls":[{"id":"call-2","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]}}]}"#,
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-2");
        assert_eq!(calls[0].arguments, "{\"path\":\"a\"}");
    }

    #[test]
    fn tools_are_only_declared_for_openai_compatible() {
        let tools = vec![DirectProviderTool {
            name: "read_file".to_owned(),
            description: "读取工作区文件".to_owned(),
            parameters: serde_json::json!({ "type": "object" }),
        }];
        let messages = vec![message("user", "看一下项目")];
        let openai = payload_for(
            &session_with(DirectProviderProtocol::OpenaiCompatible),
            "model",
            &messages,
            &tools,
        );
        assert_eq!(
            openai
                .pointer("/tools/0/function/name")
                .and_then(|value| value.as_str()),
            Some("read_file")
        );
        let anthropic = payload_for(
            &session_with(DirectProviderProtocol::AnthropicCompatible),
            "model",
            &messages,
            &tools,
        );
        assert!(anthropic.get("tools").is_none());
    }

    #[test]
    fn assistant_calls_and_tool_results_round_trip_into_the_payload() {
        let messages = vec![
            DirectProviderMessage {
                role: "assistant".to_owned(),
                content: String::new(),
                images: Vec::new(),
                tool_call_id: None,
                tool_calls: Some(
                    serde_json::json!([{ "id": "call-1", "type": "function", "function": { "name": "read_file", "arguments": "{}" } }]),
                ),
            },
            DirectProviderMessage {
                role: "tool".to_owned(),
                content: "文件内容".to_owned(),
                images: Vec::new(),
                tool_call_id: Some("call-1".to_owned()),
                tool_calls: None,
            },
        ];
        let payload = payload_for(
            &session_with(DirectProviderProtocol::OpenaiCompatible),
            "model",
            &messages,
            &[],
        );
        assert_eq!(
            payload
                .pointer("/messages/0/tool_calls/0/id")
                .and_then(|value| value.as_str()),
            Some("call-1")
        );
        assert_eq!(
            payload
                .pointer("/messages/1/role")
                .and_then(|value| value.as_str()),
            Some("tool")
        );
        assert_eq!(
            payload
                .pointer("/messages/1/tool_call_id")
                .and_then(|value| value.as_str()),
            Some("call-1")
        );
    }

    #[test]
    fn tool_results_need_a_call_id_and_may_be_empty() {
        let mut valid = vec![message("user", "读一下")];
        valid.push(DirectProviderMessage {
            role: "tool".to_owned(),
            content: String::new(),
            images: Vec::new(),
            tool_call_id: Some("call-1".to_owned()),
            tool_calls: None,
        });
        assert_eq!(validate_messages(&valid), Ok(()));
        let missing_id = vec![DirectProviderMessage {
            role: "tool".to_owned(),
            content: "结果".to_owned(),
            images: Vec::new(),
            tool_call_id: None,
            tool_calls: None,
        }];
        assert_eq!(
            validate_messages(&missing_id),
            Err("message-tool-call-id-invalid")
        );
        let unknown_role = vec![message("system", "你是助手")];
        assert_eq!(
            validate_messages(&unknown_role),
            Err("message-role-invalid")
        );
    }

    #[test]
    fn parses_openai_text_and_actual_reasoning_deltas_without_inventing_content() {
        let text = deltas_from_sse(
            DirectProviderProtocol::OpenaiCompatible,
            r#"{"choices":[{"delta":{"content":"答案"}}]}"#,
        );
        let reasoning = deltas_from_sse(
            DirectProviderProtocol::OpenaiCompatible,
            r#"{"choices":[{"delta":{"reasoning_content":"先核对约束"}}]}"#,
        );
        let empty = deltas_from_sse(
            DirectProviderProtocol::OpenaiCompatible,
            r#"{"choices":[{"delta":{"role":"assistant"}}]}"#,
        );
        assert_eq!(text, vec![("text", "答案".to_owned())]);
        assert_eq!(reasoning, vec![("reasoning", "先核对约束".to_owned())]);
        assert!(empty.is_empty());
    }

    #[test]
    fn parses_anthropic_text_and_thinking_deltas() {
        let text = deltas_from_sse(
            DirectProviderProtocol::AnthropicCompatible,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"答案"}}"#,
        );
        let reasoning = deltas_from_sse(
            DirectProviderProtocol::AnthropicCompatible,
            r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先分析"}}"#,
        );
        assert_eq!(text, vec![("text", "答案".to_owned())]);
        assert_eq!(reasoning, vec![("reasoning", "先分析".to_owned())]);
    }

    #[test]
    fn exposes_compact_provider_error_events_instead_of_silently_completing() {
        let error = super::error_from_sse(r#"{"error":{"message":"model is unavailable"}}"#);
        assert_eq!(error.as_deref(), Some("model is unavailable"));
        assert_eq!(
            super::error_from_sse(r#"{"choices":[{"delta":{"content":"ok"}}]}"#),
            None
        );
    }

    #[test]
    fn preserves_ordered_chat_history_in_provider_payload() {
        let session = super::DirectProviderSession {
            provider_id: "provider".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://example.test/v1".to_owned(),
            model: "model".to_owned(),
            api_key: "key".to_owned(),
        };
        let messages = vec![
            super::DirectProviderMessage {
                role: "user".to_owned(),
                content: "第一问".to_owned(),
                images: Vec::new(),
                ..Default::default()
            },
            super::DirectProviderMessage {
                role: "assistant".to_owned(),
                content: "第一答".to_owned(),
                images: Vec::new(),
                ..Default::default()
            },
            super::DirectProviderMessage {
                role: "user".to_owned(),
                content: "第二问".to_owned(),
                images: Vec::new(),
                ..Default::default()
            },
        ];
        assert!(super::validate_messages(&messages).is_ok());
        let payload = super::payload_for(&session, "model", &messages, &[]);
        assert_eq!(
            payload
                .pointer("/messages/0/content")
                .and_then(|value| value.as_str()),
            Some("第一问")
        );
        assert_eq!(
            payload
                .pointer("/messages/1/role")
                .and_then(|value| value.as_str()),
            Some("assistant")
        );
        assert_eq!(
            payload
                .pointer("/messages/2/content")
                .and_then(|value| value.as_str()),
            Some("第二问")
        );
    }

    #[test]
    fn emits_openai_image_content_blocks_without_discarding_user_image() {
        let session = super::DirectProviderSession {
            provider_id: "provider".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://example.test/v1".to_owned(),
            model: "model".to_owned(),
            api_key: "key".to_owned(),
        };
        let messages = vec![super::DirectProviderMessage {
            role: "user".to_owned(),
            content: "请看图片".to_owned(),
            images: vec![DirectProviderImage {
                media_type: "image/png".to_owned(),
                base64_data: "aGVsbG8=".to_owned(),
            }],
            ..Default::default()
        }];
        let payload = super::payload_for(&session, "model", &messages, &[]);
        assert_eq!(
            payload
                .pointer("/messages/0/content/0/text")
                .and_then(|value| value.as_str()),
            Some("请看图片")
        );
        assert_eq!(
            payload
                .pointer("/messages/0/content/1/image_url/url")
                .and_then(|value| value.as_str()),
            Some("data:image/png;base64,aGVsbG8=")
        );
    }

    #[test]
    fn identifies_image_specific_not_found_responses_without_claiming_local_blocking() {
        let generic = super::DirectProviderSession {
            provider_id: "provider".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://example.test/v1".to_owned(),
            model: "model".to_owned(),
            api_key: "key".to_owned(),
        };
        assert_eq!(super::http_error_message(reqwest::StatusCode::NOT_FOUND, "", true, &generic, "model"), "provider-http-404-image: 当前 Base URL、协议或模型未接受图片内容；请改用供应商支持视觉的模型或核对兼容端点");
        assert_eq!(
            super::http_error_message(reqwest::StatusCode::NOT_FOUND, "", false, &generic, "model"),
            "provider-http-404"
        );
        let mimo = super::DirectProviderSession {
            provider_id: "mimo-token-plan-cn".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://token-plan-cn.xiaomimimo.com/v1".to_owned(),
            model: "mimo-v2.5-pro".to_owned(),
            api_key: "tp-example".to_owned(),
        };
        assert_eq!(
            super::http_error_message(
                reqwest::StatusCode::NOT_FOUND,
                "",
                true,
                &mimo,
                "mimo-v2.5-pro"
            ),
            "provider-http-404-image-mimo-v25-pro"
        );
    }

    #[test]
    fn classifies_network_failures_without_returning_transport_details() {
        assert_eq!(
            super::network_error_code_from_parts(true, false, false, "ignored"),
            "provider-request-timeout"
        );
        assert_eq!(
            super::network_error_code_from_parts(false, true, false, "dns lookup failed"),
            "provider-dns-failed"
        );
        assert_eq!(
            super::network_error_code_from_parts(
                false,
                true,
                false,
                "TLS certificate verify failed"
            ),
            "provider-tls-failed"
        );
        assert_eq!(
            super::network_error_code_from_parts(false, true, false, "connection refused"),
            "provider-connect-failed"
        );
        assert_eq!(
            super::network_error_code_from_parts(false, false, true, "request builder"),
            "provider-request-invalid"
        );
    }

    #[test]
    fn token_plan_key_uses_official_api_key_header_for_custom_or_preset_connection() {
        let session = super::DirectProviderSession {
            provider_id: "custom-mimo-cn".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://token-plan-cn.xiaomimimo.com/v1".to_owned(),
            model: "mimo-v2.5-pro".to_owned(),
            api_key: "tp-example".to_owned(),
        };
        let headers = super::headers_for(&session).expect("headers");
        assert_eq!(
            headers.get("api-key").and_then(|value| value.to_str().ok()),
            Some("tp-example")
        );
        assert!(headers.get(reqwest::header::AUTHORIZATION).is_none());
    }

    #[test]
    fn custom_mimo_api_endpoint_uses_api_key_and_official_bmp_is_not_rejected() {
        let session = super::DirectProviderSession {
            provider_id: "custom-provider".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://api.xiaomimimo.com/v1".to_owned(),
            model: "mimo-v2.5".to_owned(),
            api_key: "sk-example".to_owned(),
        };
        assert!(super::is_mimo_session(&session));
        assert!(super::headers_for(&session)
            .expect("headers")
            .get("api-key")
            .is_some());
        let messages = vec![super::DirectProviderMessage {
            role: "user".to_owned(),
            content: "看图".to_owned(),
            images: vec![DirectProviderImage {
                media_type: "image/bmp".to_owned(),
                base64_data: "aGVsbG8=".to_owned(),
            }],
            ..Default::default()
        }];
        assert!(super::validate_messages(&messages).is_ok());
    }

    #[test]
    fn parses_windows_system_proxy_server_without_exposing_it_to_callers() {
        assert_eq!(
            super::windows_proxy_url_from_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            super::windows_proxy_url_from_server("http=proxy.test:8080;https=secure.test:8443")
                .as_deref(),
            Some("http://secure.test:8443")
        );
        assert_eq!(
            super::windows_proxy_url_from_server("https://already.test:443").as_deref(),
            Some("https://already.test:443")
        );
        assert_eq!(super::windows_proxy_url_from_server("   "), None);
    }

    #[test]
    fn honors_explicit_versioned_openai_base_urls_and_longcat_model_discovery_route() {
        let ark = super::DirectProviderSession {
            provider_id: "doubao-ark".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://ark.cn-beijing.volces.com/api/v3".to_owned(),
            model: "doubao-seed-2-1-pro-260628".to_owned(),
            api_key: "key".to_owned(),
        };
        assert_eq!(
            super::url_for(&ark),
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        );
        let deepseek = super::DirectProviderSession {
            provider_id: "deepseek".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://api.deepseek.com/v1".to_owned(),
            model: "deepseek-v4-flash".to_owned(),
            api_key: "key".to_owned(),
        };
        assert_eq!(
            super::url_for(&deepseek),
            "https://api.deepseek.com/v1/chat/completions"
        );
        let qianfan = super::DirectProviderSession {
            provider_id: "baidu-qianfan".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://qianfan.baidubce.com/v2".to_owned(),
            model: "ernie-5.1".to_owned(),
            api_key: "key".to_owned(),
        };
        assert_eq!(
            super::url_for(&qianfan),
            "https://qianfan.baidubce.com/v2/chat/completions"
        );
        let legacy_deepseek = super::DirectProviderSession {
            provider_id: "deepseek".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://api.deepseek.com".to_owned(),
            model: "deepseek-v4-pro".to_owned(),
            api_key: "key".to_owned(),
        };
        assert_eq!(
            super::model_list_url_for(&legacy_deepseek),
            "https://api.deepseek.com/v1/models"
        );
        let longcat = super::DirectProviderSession {
            provider_id: "longcat".to_owned(),
            protocol: DirectProviderProtocol::OpenaiCompatible,
            base_url: "https://api.longcat.chat/openai/v1".to_owned(),
            model: "LongCat-2.0".to_owned(),
            api_key: "key".to_owned(),
        };
        assert_eq!(
            super::model_list_url_for(&longcat),
            "https://api.longcat.chat/v1/models"
        );
    }
}
