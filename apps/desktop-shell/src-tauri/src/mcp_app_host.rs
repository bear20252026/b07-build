//! MCP App 文档服务（R4-01）：为不受信插件 HTML 提供**独立来源**的隔离文档。
//!
//! 为什么必须存在：srcdoc / data: 等「本地方案」文档会**继承**父文档的 CSP
//! （W3C CSP 规范），而主窗口 CSP 是 `script-src 'self'`——插件的内联脚本在
//! 继承策略下根本无法运行，注入的 CSP 只会叠加不会放宽。本模块用 Tauri 自定义
//! 协议 `mcpapp://` 提供拥有独立响应的文档：CSP 作为**响应头**下发时全部指令
//! 生效，主窗口 CSP 保持严格、不放宽。
//!
//! 生命周期：workbench 在渲染实例前 `mcpapp_stage_document`（HTML + CSP 驻留
//! 本机内存），iframe 指向 `mcpapp://<host>/<instanceId>/index.html`
//! （Windows/WebView2 映射为 `http://mcpapp.<host>/<instanceId>/index.html`）；
//! 卸载或换代后 `mcpapp_release_document`。
//!
//! `<host>` 由应用身份派生（P2-3）：同一 app 恒定、不同 app 不同，来源天然隔离
//! （`localhost` 是留给既有共享来源调用方的兼容形态）。**路由只看路径**——
//! `serve_mcpapp_document` 只接收 `request.uri().path()`，宿主信息一律忽略，
//! 因此换 host 不需要改路由，`/`、`/<id>`、`/unknown/...` 的既有行为保持不变。
//! 文档不落盘、不上传；沙箱 iframe 无 allow-same-origin，应用处于不透明源。

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::State;

/// 文档体积上限：与工作区单文件一致，防内存滥用。
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_CSP_CHARS: usize = 4_096;

#[derive(Clone)]
struct McpAppDocument {
    html: String,
    content_security_policy: String,
}

/// 实例文档注册表：instanceId → 文档。仅在内存中，进程退出即消失。
#[derive(Default)]
pub struct McpAppDocumentState(Mutex<HashMap<String, McpAppDocument>>);

impl McpAppDocumentState {
    pub fn new() -> Self {
        McpAppDocumentState(Mutex::new(HashMap::new()))
    }
}

fn valid_instance_id(instance_id: &str) -> bool {
    !instance_id.is_empty()
        && instance_id.len() <= 64
        && instance_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// CSP 作为响应头下发，值里绝不允许出现头注入字符。
fn valid_csp(csp: &str) -> bool {
    !csp.is_empty()
        && csp.len() <= MAX_CSP_CHARS
        && !csp.chars().any(|c| matches!(c, '\r' | '\n' | '\0' | '"'))
}

/// 暂存实例文档；同 instanceId 重复暂存视为换代（整体替换）。
pub fn stage_document(
    state: &McpAppDocumentState,
    instance_id: &str,
    html: &str,
    content_security_policy: &str,
) -> Result<(), String> {
    if !valid_instance_id(instance_id) {
        return Err("mcpapp-instance-id-invalid".to_owned());
    }
    if html.len() > MAX_HTML_BYTES {
        return Err("mcpapp-html-too-large".to_owned());
    }
    if !valid_csp(content_security_policy) {
        return Err("mcpapp-csp-invalid".to_owned());
    }
    let mut documents = state
        .0
        .lock()
        .map_err(|_| "mcpapp-state-unavailable".to_owned())?;
    documents.insert(
        instance_id.to_owned(),
        McpAppDocument {
            html: html.to_owned(),
            content_security_policy: content_security_policy.to_owned(),
        },
    );
    Ok(())
}

/// 释放实例文档（卸载或换代）；未知的 instanceId 静默成功（幂等）。
pub fn release_document(state: &McpAppDocumentState, instance_id: &str) {
    if let Ok(mut documents) = state.0.lock() {
        documents.remove(instance_id);
    }
}

/// 服务结果：状态码 + CSP 响应头（仅 200）+ 正文。
pub struct ServedMcpAppDocument {
    pub status: u16,
    pub content_security_policy: Option<String>,
    pub body: Vec<u8>,
}

/// 从协议请求路径解析并服务文档。路径第一段 = instanceId，
/// 其余段必须是 `index.html`（或省略）。宿主（`<host>` / `mcpapp.<host>`）
/// 只决定浏览器侧来源，**不参与路由**：本函数只消费路径。
pub fn serve_mcpapp_document(state: &McpAppDocumentState, uri_path: &str) -> ServedMcpAppDocument {
    let not_found = || ServedMcpAppDocument {
        status: 404,
        content_security_policy: None,
        body: b"not found".to_vec(),
    };
    let trimmed = uri_path.trim_start_matches('/');
    let mut segments = trimmed.split('/');
    let Some(instance_id) = segments.next() else {
        return not_found();
    };
    if !valid_instance_id(instance_id) {
        return not_found();
    }
    match segments.next() {
        None | Some("index.html") => {}
        Some(_) => return not_found(),
    }
    if segments.next().is_some() {
        return not_found();
    }
    let documents = match state.0.lock() {
        Ok(documents) => documents,
        Err(_) => return not_found(),
    };
    let Some(document) = documents.get(instance_id) else {
        return not_found();
    };
    ServedMcpAppDocument {
        status: 200,
        content_security_policy: Some(document.content_security_policy.clone()),
        body: document.html.as_bytes().to_vec(),
    }
}

#[tauri::command]
pub fn mcpapp_stage_document(
    state: State<'_, McpAppDocumentState>,
    instance_id: String,
    html: String,
    content_security_policy: String,
) -> Result<(), String> {
    stage_document(&state, &instance_id, &html, &content_security_policy)
}

#[tauri::command]
pub fn mcpapp_release_document(
    state: State<'_, McpAppDocumentState>,
    instance_id: String,
) -> Result<(), String> {
    release_document(&state, &instance_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{release_document, serve_mcpapp_document, stage_document, McpAppDocumentState};

    #[test]
    fn staged_document_is_served_with_csp_header_and_404_otherwise() {
        let state = McpAppDocumentState::new();
        stage_document(
            &state,
            "inst-1",
            "<html><body>app</body></html>",
            "default-src 'none'",
        )
        .unwrap();
        let served = serve_mcpapp_document(&state, "/inst-1/index.html");
        assert_eq!(served.status, 200);
        assert_eq!(
            served.content_security_policy.as_deref(),
            Some("default-src 'none'")
        );
        assert_eq!(served.body, b"<html><body>app</body></html>");
        // 省略 index.html 亦可；未知实例 404。
        assert_eq!(serve_mcpapp_document(&state, "/inst-1").status, 200);
        assert_eq!(
            serve_mcpapp_document(&state, "/unknown/index.html").status,
            404
        );
        // 释放后同样 404（幂等释放）。
        release_document(&state, "inst-1");
        release_document(&state, "inst-1");
        assert_eq!(
            serve_mcpapp_document(&state, "/inst-1/index.html").status,
            404
        );
    }

    #[test]
    fn path_traversal_and_bad_ids_are_rejected() {
        let state = McpAppDocumentState::new();
        stage_document(&state, "inst-1", "<html></html>", "default-src 'none'").unwrap();
        for path in [
            "/../etc/passwd",
            "/inst-1/../../etc/passwd",
            "/inst-1/extra/deep",
            "/inst-1/not-index.html",
            "/bad%20id/index.html",
        ] {
            assert_eq!(serve_mcpapp_document(&state, path).status, 404, "{path}");
        }
        assert!(stage_document(&state, "bad id", "<html></html>", "default-src 'none'").is_err());
        assert!(stage_document(&state, "", "<html></html>", "default-src 'none'").is_err());
    }

    #[test]
    fn csp_header_injection_and_oversize_are_rejected() {
        let state = McpAppDocumentState::new();
        // 头注入：CSP 值里带换行可以伪造任意响应头。
        assert!(stage_document(
            &state,
            "inst-1",
            "<html></html>",
            "default-src 'none'\r\nX-Injected: 1"
        )
        .is_err());
        assert!(stage_document(&state, "inst-1", "<html></html>", "").is_err());
        let huge = "x".repeat(2 * 1024 * 1024 + 1);
        assert!(stage_document(&state, "inst-1", &huge, "default-src 'none'").is_err());
        assert!(serve_mcpapp_document(&state, "/inst-1/index.html").status == 404);
    }
}
