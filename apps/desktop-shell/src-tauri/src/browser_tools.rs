//! 浏览器工具面的原生执行面：把 CDP 连接与工具映射接到 Tauri 命令上。
//!
//! ## 这一层为什么不放在 `capability-placeholder`
//!
//! `capability-placeholder` 的 `package.json` 只依赖 `@awo/protocol`，是一个
//! **纯契约包**（其 description 写明"fail-closed 契约占位包"）——它不做任何 IO。
//! WebSocket 连接、进程内的会话状态、TCP 读写都是 IO，放进那个包会破坏它
//! "契约与实现分离"的定位，也会让一个本可被任意前端引用的类型包被迫带上
//! 原生依赖。
//!
//! 因此分工是：
//! - `capability-placeholder`：工具面契约 + 可注入的 `BrowserToolHandler` 缝（不变）；
//! - `crates/cdp-client`：协议判定（帧、端点、工具映射、会话状态机），纯逻辑零 IO；
//! - `crates/cdp-transport`：把判定落到真实 WebSocket；
//! - **本模块**：持有连接、承接 Tauri 命令、把结果翻译成工具面要的形状。
//!
//! ## 会话模型的取舍
//!
//! 一个"浏览会话"= 一条 CDP 连接 + 一个已配对的目标（tab）。`create_session`
//! 做的是：连上 `ws://127.0.0.1:<port>/devtools/browser/...`、请求目标列表、
//! 选第一个 `page` 类型并 attach。这一串在 CDP 里是四步，但对 Agent 而言是
//! 一件事——因此它在 Rust 侧一次做完，只把 `sessionId` 交回去。
//!
//! ## fail-closed 纪律（与占位包一致）
//!
//! 任何一步失败都返回**稳定的错误码**，绝不用空结果假装成功。特别是：
//! 工具名不在 13 个之内、参数结构不符、CDP 拒绝——全部上抛，不吞。

use std::collections::HashMap;
use std::sync::Mutex;

use cdp_client::tool_map::{map_tool_call, ToolMapOutcome};
use cdp_transport::{CdpConnection, ConnectOptions, TransportError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 默认的 CDP 调试端口（Chrome/Edge 的 `--remote-debugging-port` 常用值）。
const DEFAULT_DEBUGGER_PORT: u16 = 9222;
/// 一个会话最多允许的并发在途命令（防上层把连接用爆）。
const MAX_INFLIGHT_COMMANDS: usize = 64;
/// 单次工具调用的结果文本上限（字符），超出截断并标注。
const MAX_RESULT_CHARS: usize = 128_000;

/// 一次工具调用的结果（与 TS 侧 `BrowserToolCallResult` 同形）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolCallResult {
    /// 与 MCP 工具结果同形的内容块。
    pub content: Vec<BrowserToolContent>,
    /// 是否出错。
    pub is_error: bool,
    /// 稳定错误码（出错时必有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

/// 一个内容块（目前只有文本）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolContent {
    /// 块类型，恒为 `text`。
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// 文本内容。
    pub text: String,
}

impl BrowserToolCallResult {
    fn ok(text: impl Into<String>) -> Self {
        Self {
            content: vec![BrowserToolContent {
                kind: "text",
                text: truncate(text.into()),
            }],
            is_error: false,
            error_code: None,
        }
    }

    fn err(code: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            content: vec![BrowserToolContent {
                kind: "text",
                text: truncate(text.into()),
            }],
            is_error: true,
            error_code: Some(code.into()),
        }
    }
}

/// 按字符（而非字节）截断，避免切断 UTF-8 序列。
fn truncate(text: String) -> String {
    if text.chars().count() <= MAX_RESULT_CHARS {
        return text;
    }
    let kept: String = text.chars().take(MAX_RESULT_CHARS).collect();
    format!("{kept}\n…（结果超过 {MAX_RESULT_CHARS} 字符，已截断）")
}

/// 一次工具调用的入参（来自 TS 侧的 `BrowserToolCall`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolCallRequest {
    /// canonical 工具名（`mcp__browser__<tool>`）。
    pub tool_name: String,
    /// 工具参数。
    #[serde(default)]
    pub arguments: Option<Value>,
}

/// 一个浏览会话。
struct BrowserSession {
    connection: CdpConnection,
    /// 已配对的目标 id（tab）。
    target_id: String,
}

/// 原生执行面的共享状态。
///
/// 用 `Mutex` 而不是每会话一个任务：CDP 命令是"发出去 — 收回来"的短交互，
/// 且**同一条连接上的命令必须串行化在途表**（见 `cdp-client::session` 的说明）。
/// 为一次工具调用起一个任务只会让"谁持有连接"变复杂，而浏览器自动化本身
/// 也不是吞吐受限的场景。
pub struct BrowserToolState {
    sessions: Mutex<HashMap<String, BrowserSession>>,
    /// 下一个会话编号（单调递增，用于生成稳定的 sessionId）。
    next_session: Mutex<u64>,
    /// 调试端口（可配置；默认 9222）。
    debugger_port: Mutex<u16>,
    /// 是否启用真实后端。**缺省关闭**——与占位包的 fail-closed 纪律一致，
    /// 必须由用户显式开启，绝不"因为代码在就默认可用"。
    enabled: Mutex<bool>,
}

impl Default for BrowserToolState {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserToolState {
    /// 新建状态：**后端默认关闭**。
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_session: Mutex::new(1),
            debugger_port: Mutex::new(DEFAULT_DEBUGGER_PORT),
            enabled: Mutex::new(false),
        }
    }

    /// 后端是否已启用。
    pub fn is_enabled(&self) -> Result<bool, &'static str> {
        self.enabled
            .lock()
            .map(|flag| *flag)
            .map_err(|_| "browser-backend-state-unavailable")
    }

    /// 启用或关闭真实后端。关闭时同时断开全部会话。
    pub fn set_enabled(&self, enabled: bool) -> Result<usize, &'static str> {
        *self
            .enabled
            .lock()
            .map_err(|_| "browser-backend-state-unavailable")? = enabled;
        if enabled {
            Ok(0)
        } else {
            // 关闭后端必须**真的断开**连接：留着连接会让"已关闭"变成一句空话。
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "browser-backend-state-unavailable")?;
            let count = sessions.len();
            sessions.clear();
            Ok(count)
        }
    }

    /// 当前的调试端口。
    pub fn debugger_port(&self) -> Result<u16, &'static str> {
        self.debugger_port
            .lock()
            .map(|port| *port)
            .map_err(|_| "browser-backend-state-unavailable")
    }

    /// 设定调试端口。**只在没有活动会话时允许**——改端口而不断开连接，
    /// 会让"会话指向哪里"变得不可知。
    pub fn set_debugger_port(&self, port: u16) -> Result<(), &'static str> {
        if port == 0 {
            return Err("browser-debugger-port-invalid");
        }
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "browser-backend-state-unavailable")?;
        if !sessions.is_empty() {
            return Err("browser-debugger-port-change-requires-no-sessions");
        }
        drop(sessions);
        *self
            .debugger_port
            .lock()
            .map_err(|_| "browser-backend-state-unavailable")? = port;
        Ok(())
    }
}

/// 把传输层错误翻译成工具面错误码。
fn transport_error_code(error: &TransportError) -> String {
    error.code()
}

/// 从版本发现端点里取出浏览器级 websocket 地址。
///
/// 用 `reqwest` 走 HTTP 而不是 CDP 的 websocket：`/json/version` 是 HTTP 接口，
/// 且这是**唯一**能拿到浏览器级（而非页面级）调试地址的途径——直接连页面级地址
/// 会让 `Target.*` 一族方法全部不可用。
async fn discover_browser_endpoint(port: u16) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| "browser-discovery-unavailable".to_string())?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "browser-debugger-unreachable".to_string())?;
    if !response.status().is_success() {
        return Err("browser-debugger-rejected".to_string());
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "browser-discovery-response-invalid".to_string())?;
    body.get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "browser-discovery-missing-websocket-url".to_string())
}

/// 组装"连上并 attach 到第一个 page 目标"所需的命令序列。
///
/// 返回 `(attach 命令参数, 从结果里取 sessionId 的字段路径)`。
/// 单独抽出来是为了让它**可以被单测**：这段逻辑的错误表现为"连上了但所有
/// 页面命令都报找不到会话"，且不会在连接阶段暴露。
fn attach_params(target_id: &str) -> Value {
    serde_json::json!({ "targetId": target_id, "flatten": true })
}

/// 从 `/json/list` 的响应里挑第一个 page 目标的 id。
fn first_page_target(list: &Value) -> Option<String> {
    list.as_array()?
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some("page"))
        .and_then(|entry| entry.get("id").and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
}

/// 请求目标列表。
async fn list_targets(port: u16) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{port}/json/list");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| "browser-discovery-unavailable".to_string())?;
    client
        .get(&url)
        .send()
        .await
        .map_err(|_| "browser-debugger-unreachable".to_string())?
        .json()
        .await
        .map_err(|_| "browser-discovery-response-invalid".to_string())
}

/// 执行一次工具调用。
///
/// **所有失败路径都返回带稳定错误码的结果**，不返回 `Err`——因为对 Agent 而言
/// "工具调用失败"是**结果**（要交给模型看），而不是宿主层面的异常。
pub async fn call_browser_tool(
    state: &BrowserToolState,
    call: BrowserToolCallRequest,
) -> BrowserToolCallResult {
    // ① 后端未启用：与占位包的拒答保持同一语义（稳定码 + 可读原因）。
    match state.is_enabled() {
        Ok(true) => {}
        Ok(false) => {
            return BrowserToolCallResult::err(
                "browser_tool_backend_unavailable",
                format!(
                    "浏览器真实后端未启用（工具：{}）。启用前工具面对外报告不可用。",
                    call.tool_name
                ),
            )
        }
        Err(code) => {
            return BrowserToolCallResult::err(
                code,
                "浏览器后端状态不可读；已按不可用处理（fail-closed）。",
            )
        }
    }

    // ② 工具名与参数映射（纯函数，失败即拒——不发任何命令）。
    let steps = match map_tool_call(&call.tool_name, call.arguments.as_ref()) {
        ToolMapOutcome::Steps(steps) => steps,
        ToolMapOutcome::Unmappable(failure) => {
            return BrowserToolCallResult::err(
                failure.code(),
                format!("工具调用无法映射为 CDP 命令（工具：{}）", call.tool_name),
            )
        }
    };

    // ③ 会话生命周期工具在本地处理（它们管理的正是"连接"本身，不能发给连接）。
    let suffix = match cdp_client::tool_map::tool_suffix(&call.tool_name) {
        Some(suffix) => suffix,
        None => {
            return BrowserToolCallResult::err(
                "tool_map_unknown_tool",
                format!("不是已登记的浏览器工具：{}", call.tool_name),
            )
        }
    };
    match suffix {
        "list_sessions" => return list_sessions(state),
        "close_session" => return close_session(state, call.arguments.as_ref()),
        "create_session" => return create_session(state).await,
        _ => {}
    }

    // ④ 其余工具需要一条已建立的会话：从参数里取 sessionId。
    let session_id = match call
        .arguments
        .as_ref()
        .and_then(|value| value.get("sessionId"))
        .and_then(Value::as_str)
    {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => {
            return BrowserToolCallResult::err(
                "tool_map_missing_parameter:sessionId",
                "该工具需要 sessionId；请先用 create_session 建立一个浏览会话。",
            )
        }
    };

    // ⑤ 逐条发出 CDP 步骤并收集结果。任一步失败即中止——继续在错误状态上跑
    // 后续步骤是浏览器自动化里最贵的一类缺陷。
    //
    // 并发纪律：**绝不把 `MutexGuard` 跨 `.await` 持有**。那样做的后果不是编译
    // 报错（虽然它确实也通不过），而是所有浏览会话在整段网络 IO 期间被串成一条
    // 队列——一个会话卡在慢页面上，其余会话连 `list_sessions` 都查不了。
    //
    // 做法是把连接从表里**临时取出**：这是本模块唯一需要跨 await 的可变状态，
    // 取出后表本身立即释放，其他会话的操作不受影响。取出的那一小段时间里，
    // 该 sessionId 在表里不存在——因此 `list_sessions` 查不到它（符合事实：
    // 它正在执行命令），而 `close_session` 对它返回"不存在"（见下方说明）。
    let mut session = match state.sessions.lock() {
        Ok(mut sessions) => match sessions.remove(&session_id) {
            Some(session) => session,
            None => {
                return BrowserToolCallResult::err(
                    "browser-session-unknown",
                    format!("不存在该浏览会话：{session_id}"),
                )
            }
        },
        Err(_) => {
            return BrowserToolCallResult::err(
                "browser-backend-state-unavailable",
                "会话表不可读；已按失败处理（fail-closed）。",
            )
        }
    };
    if session.connection.pending_count() >= MAX_INFLIGHT_COMMANDS {
        // 放回表里再报错——否则一次"忙碌"就把会话**弄丢了**。
        let _ = state
            .sessions
            .lock()
            .map(|mut sessions| sessions.insert(session_id.clone(), session));
        return BrowserToolCallResult::err(
            "browser-session-busy",
            format!("会话 {session_id} 的在途命令已达上限（{MAX_INFLIGHT_COMMANDS}）。"),
        );
    }

    let execution = execute_steps(&mut session, &steps).await;

    // 无论成功还是失败都必须**放回**表里：不放回等于一次失败的调用让会话消失。
    let restored = state
        .sessions
        .lock()
        .map(|mut sessions| sessions.insert(session_id.clone(), session))
        .is_ok();
    if !restored {
        return BrowserToolCallResult::err(
            "browser-backend-state-unavailable",
            "会话表不可写；命令已执行但会话无法登记（fail-closed）。",
        );
    }
    execution
}

/// 依次执行映射出的 CDP 步骤，收集结果。
///
/// 单独抽出来是为了让"执行"与"会话表管理"两件事分开：前者跨 await，
/// 后者必须尽快释放锁。混在一起是上一条并发缺陷的来源。
async fn execute_steps(
    session: &mut BrowserSession,
    steps: &[cdp_client::tool_map::CdpStep],
) -> BrowserToolCallResult {
    let mut collected: Vec<Value> = Vec::with_capacity(steps.len());
    for step in steps {
        let registered = match session
            .connection
            .send(&step.method, step.params.clone(), None)
            .await
        {
            Ok(registered) => registered,
            Err(error) => {
                return BrowserToolCallResult::err(
                    transport_error_code(&error),
                    format!("发送 {} 失败：{}", step.method, error.detail()),
                )
            }
        };
        match session.connection.await_response(registered.id).await {
            Ok(cdp_client::frame::CommandOutcome::Ok(value)) => collected.push(value),
            Ok(cdp_client::frame::CommandOutcome::Err { code, message }) => {
                return BrowserToolCallResult::err(
                    format!("cdp_error_{code}"),
                    format!("CDP 方法 {} 失败：{message}", step.method),
                )
            }
            Err(error) => {
                return BrowserToolCallResult::err(
                    transport_error_code(&error),
                    format!("等待 {} 的响应失败：{}", step.method, error.detail()),
                )
            }
        }
    }
    BrowserToolCallResult::ok(render_steps(steps, &collected))
}

/// 把若干 CDP 结果渲染成一段可读文本。
fn render_steps(steps: &[cdp_client::tool_map::CdpStep], results: &[Value]) -> String {
    let mut out = String::new();
    for (index, step) in steps.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&format!("[{}]", step.method));
        if let Some(result) = results.get(index) {
            if !result.is_null() {
                out.push(' ');
                out.push_str(&result.to_string());
            }
        }
    }
    if out.trim().is_empty() {
        "（无返回内容）".to_string()
    } else {
        out
    }
}

/// 列出当前会话。
fn list_sessions(state: &BrowserToolState) -> BrowserToolCallResult {
    let sessions = match state.sessions.lock() {
        Ok(sessions) => sessions,
        Err(_) => {
            return BrowserToolCallResult::err(
                "browser-backend-state-unavailable",
                "会话表不可读；已按失败处理（fail-closed）。",
            )
        }
    };
    if sessions.is_empty() {
        return BrowserToolCallResult::ok("当前没有浏览会话。");
    }
    let mut lines: Vec<String> = sessions
        .iter()
        .map(|(id, session)| {
            format!(
                "{id} · 目标 {} · 在途 {}",
                session.target_id,
                session.connection.pending_count()
            )
        })
        .collect();
    // 排序让输出稳定（HashMap 迭代顺序不确定，会让同一状态的两次调用给出不同文本）。
    lines.sort();
    BrowserToolCallResult::ok(lines.join("\n"))
}

/// 关闭一个会话。
fn close_session(state: &BrowserToolState, arguments: Option<&Value>) -> BrowserToolCallResult {
    let session_id = match arguments
        .and_then(|value| value.get("sessionId"))
        .and_then(Value::as_str)
    {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => {
            return BrowserToolCallResult::err(
                "tool_map_missing_parameter:sessionId",
                "close_session 需要 sessionId。",
            )
        }
    };
    let mut sessions = match state.sessions.lock() {
        Ok(sessions) => sessions,
        Err(_) => {
            return BrowserToolCallResult::err(
                "browser-backend-state-unavailable",
                "会话表不可读；已按失败处理（fail-closed）。",
            )
        }
    };
    match sessions.remove(&session_id) {
        Some(_) => BrowserToolCallResult::ok(format!("已关闭浏览会话 {session_id}。")),
        None => BrowserToolCallResult::err(
            "browser-session-unknown",
            format!("不存在该浏览会话：{session_id}"),
        ),
    }
}

/// 建立一个新浏览会话：发现端点 → 连上 → 选 page 目标 → attach。
async fn create_session(state: &BrowserToolState) -> BrowserToolCallResult {
    let port = match state.debugger_port() {
        Ok(port) => port,
        Err(code) => {
            return BrowserToolCallResult::err(code, "调试端口不可读；已按失败处理。");
        }
    };
    // ① 发现浏览器级 websocket 地址。
    let websocket_url = match discover_browser_endpoint(port).await {
        Ok(url) => url,
        Err(code) => {
            return BrowserToolCallResult::err(
                code,
                format!("无法发现调试端点（端口 {port}）。请确认浏览器以 --remote-debugging-port={port} 启动。"),
            )
        }
    };
    // ② 建连（端点判定在传输层内部完成，这里不重复白名单）。
    let mut connection = match CdpConnection::connect(ConnectOptions {
        websocket_url,
        ..ConnectOptions::default()
    })
    .await
    {
        Ok(connection) => connection,
        Err(error) => {
            return BrowserToolCallResult::err(
                transport_error_code(&error),
                format!("连接调试端点失败：{}", error.detail()),
            )
        }
    };
    // ③ 选一个 page 目标。
    let target_id = match list_targets(port).await {
        Ok(list) => match first_page_target(&list) {
            Some(id) => id,
            None => {
                return BrowserToolCallResult::err(
                    "browser-no-page-target",
                    "调试端点没有可用的 page 目标；请先打开一个标签页。",
                )
            }
        },
        Err(code) => {
            return BrowserToolCallResult::err(code, "读取目标列表失败。");
        }
    };
    // ④ attach 并在**扁平会话模型**下拿到会话 id。
    let registered = match connection
        .send(
            "Target.attachToTarget",
            Some(attach_params(&target_id)),
            None,
        )
        .await
    {
        Ok(registered) => registered,
        Err(error) => {
            return BrowserToolCallResult::err(
                transport_error_code(&error),
                format!("发送 Target.attachToTarget 失败：{}", error.detail()),
            )
        }
    };
    let session_id = match connection.await_response(registered.id).await {
        Ok(cdp_client::frame::CommandOutcome::Ok(value)) => value
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        Ok(cdp_client::frame::CommandOutcome::Err { code, message }) => {
            return BrowserToolCallResult::err(
                format!("cdp_error_{code}"),
                format!("attach 到目标 {target_id} 失败：{message}"),
            )
        }
        Err(error) => {
            return BrowserToolCallResult::err(
                transport_error_code(&error),
                format!("等待 attach 响应失败：{}", error.detail()),
            )
        }
    };
    let Some(cdp_session_id) = session_id else {
        return BrowserToolCallResult::err(
            "browser-attach-missing-session",
            "attach 成功但没有返回 sessionId；该调试端点不支持扁平会话模型。",
        );
    };
    // 把会话 id 挂到连接上，此后所有命令自动带上它。
    connection.set_session_id(Some(cdp_session_id));

    // ⑤ 登记会话。
    let session_id = match state.next_session.lock() {
        Ok(mut next) => {
            let id = format!("browser-session-{}", *next);
            *next = next.saturating_add(1);
            id
        }
        Err(_) => {
            return BrowserToolCallResult::err(
                "browser-backend-state-unavailable",
                "会话编号不可分配；已按失败处理（fail-closed）。",
            )
        }
    };
    match state.sessions.lock() {
        Ok(mut sessions) => {
            sessions.insert(
                session_id.clone(),
                BrowserSession {
                    connection,
                    target_id: target_id.clone(),
                },
            );
        }
        Err(_) => {
            return BrowserToolCallResult::err(
                "browser-backend-state-unavailable",
                "会话表不可写；已按失败处理（fail-closed）。",
            )
        }
    }
    BrowserToolCallResult::ok(format!("已创建浏览会话 {session_id}（目标 {target_id}）。"))
}

/// 浏览器真实后端的启用状态与配置（**不含**任何 URL、页面内容或凭据）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBackendStatus {
    /// 是否启用。
    pub enabled: bool,
    /// 当前调试端口。
    pub debugger_port: u16,
    /// 活动会话数。
    pub session_count: usize,
}

/// 查询后端状态。前端据此把工具面的 `available` 从 false 变为真实可用。
#[tauri::command]
pub fn browser_backend_status(
    state: tauri::State<'_, BrowserToolState>,
) -> Result<BrowserBackendStatus, &'static str> {
    let enabled = state.is_enabled()?;
    let debugger_port = state.debugger_port()?;
    let session_count = state
        .sessions
        .lock()
        .map_err(|_| "browser-backend-state-unavailable")?
        .len();
    Ok(BrowserBackendStatus {
        enabled,
        debugger_port,
        session_count,
    })
}

/// 启用 / 关闭真实后端。关闭会断开全部会话。
#[tauri::command]
pub fn browser_backend_set_enabled(
    state: tauri::State<'_, BrowserToolState>,
    enabled: bool,
) -> Result<usize, &'static str> {
    state.set_enabled(enabled)
}

/// 设定调试端口（要求当前无活动会话）。
#[tauri::command]
pub fn browser_backend_set_port(
    state: tauri::State<'_, BrowserToolState>,
    port: u16,
) -> Result<(), &'static str> {
    state.set_debugger_port(port)
}

/// 执行一次浏览器工具调用（TS 侧 `BrowserToolHandler` 的落地实现）。
#[tauri::command]
pub async fn browser_tool_call(
    state: tauri::State<'_, BrowserToolState>,
    request: BrowserToolCallRequest,
) -> Result<BrowserToolCallResult, &'static str> {
    Ok(call_browser_tool(&state, request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 后端默认关闭() {
        let state = BrowserToolState::new();
        assert!(!state.is_enabled().unwrap());
    }

    #[test]
    fn 关闭后端会断开全部会话计数() {
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        // 没有真实连接，只验证"关闭返回被清掉的会话数"这一语义。
        assert_eq!(state.set_enabled(false).unwrap(), 0);
        assert!(!state.is_enabled().unwrap());
    }

    #[test]
    fn 调试端口为零被拒绝() {
        let state = BrowserToolState::new();
        assert_eq!(
            state.set_debugger_port(0).unwrap_err(),
            "browser-debugger-port-invalid"
        );
    }

    #[test]
    fn 端口可设定但也必须为正() {
        let state = BrowserToolState::new();
        assert_eq!(state.debugger_port().unwrap(), DEFAULT_DEBUGGER_PORT);
        state.set_debugger_port(9333).unwrap();
        assert_eq!(state.debugger_port().unwrap(), 9333);
    }

    #[test]
    fn 只挑page类型的目标() {
        let list = serde_json::json!([
            { "id": "worker-1", "type": "service_worker" },
            { "id": "page-1", "type": "page" },
            { "id": "page-2", "type": "page" },
        ]);
        assert_eq!(first_page_target(&list).as_deref(), Some("page-1"));
    }

    #[test]
    fn 没有page目标时返回none() {
        let list = serde_json::json!([{ "id": "w", "type": "service_worker" }]);
        assert_eq!(first_page_target(&list), None);
        // 非数组也返回 None，而不是 panic。
        assert_eq!(first_page_target(&serde_json::json!({})), None);
    }

    #[test]
    fn 空id的page目标被跳过() {
        // `id` 为空串的目标不可 attach；选中它会让 attach 静默失败。
        let list = serde_json::json!([{ "id": "   ", "type": "page" }]);
        assert_eq!(first_page_target(&list), None);
    }

    #[test]
    fn attach参数带flatten与目标id() {
        let params = attach_params("page-1");
        assert_eq!(params["targetId"], serde_json::json!("page-1"));
        // `flatten: true` 是扁平会话模型的前提：为假时会话 id 不会再出现
        // 在我们发出的每条命令上，导致页面命令全部找不到会话。
        assert_eq!(params["flatten"], serde_json::json!(true));
    }

    #[test]
    fn 后端关闭时任何工具调用都以稳定码失败() {
        let state = BrowserToolState::new();
        let result = futures_lite_block_on(call_browser_tool(
            &state,
            BrowserToolCallRequest {
                tool_name: "mcp__browser__navigate".to_string(),
                arguments: Some(serde_json::json!({ "sessionId": "s", "url": "https://e.com" })),
            },
        ));
        assert!(result.is_error);
        assert_eq!(
            result.error_code.as_deref(),
            Some("browser_tool_backend_unavailable")
        );
    }

    #[test]
    fn 后端启用后未登记工具仍被拒() {
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        let result = futures_lite_block_on(call_browser_tool(
            &state,
            BrowserToolCallRequest {
                tool_name: "mcp__browser__not_a_tool".to_string(),
                arguments: None,
            },
        ));
        assert!(result.is_error);
        assert_eq!(result.error_code.as_deref(), Some("tool_map_unknown_tool"));
    }

    #[test]
    fn 后端启用后缺参数的工具调用被拒且不发命令() {
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        // navigate 缺 url。
        let result = futures_lite_block_on(call_browser_tool(
            &state,
            BrowserToolCallRequest {
                tool_name: "mcp__browser__navigate".to_string(),
                arguments: Some(serde_json::json!({ "sessionId": "s" })),
            },
        ));
        assert!(result.is_error);
        assert_eq!(
            result.error_code.as_deref(),
            Some("tool_map_missing_parameter:url")
        );
    }

    #[test]
    fn 可映射但会话不存在时以会话未知失败() {
        // 这里刻意用「映射得通、但会话不存在」的调用，钉住两条次序纪律：
        // ① 参数映射（步骤 ②）发生在会话查表（步骤 ④）**之前**，故映射错误会先报；
        // ② 反过来，映射通过后若 sessionId 不在表里，必须 fail-closed 报"会话未知"，
        //    **不能**因为"这一步纯逻辑上算得出来"就假装成功——真实执行需要一条活连接。
        // 早期的版本断言这里是成功并检查 `Page.navigate`，那是错的：单元测试里
        // 不可能有活连接，该断言实际上永远走不到（它断言的是步骤 ⑤ 的输出，
        // 而输入只到得了步骤 ④）。步骤清单本身的渲染改由下面两个纯函数测试钉住。
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        let result = futures_lite_block_on(call_browser_tool(
            &state,
            BrowserToolCallRequest {
                tool_name: "mcp__browser__navigate".to_string(),
                arguments: Some(serde_json::json!({ "sessionId": "s", "url": "https://e.com" })),
            },
        ));
        assert!(result.is_error);
        assert_eq!(
            result.error_code.as_deref(),
            Some("browser-session-unknown")
        );
    }

    #[test]
    fn 映射navigate产出page_navigate步骤() {
        // 纯函数直测：不经过会话，直接钉住"工具 → CDP 步骤"的映射结果。
        // 这条判定此前只被集成路径覆盖，而集成路径需要活连接、单元测试到不了。
        let steps = match map_tool_call(
            "mcp__browser__navigate",
            Some(&serde_json::json!({ "sessionId": "s", "url": "https://e.com" })),
        ) {
            ToolMapOutcome::Steps(steps) => steps,
            ToolMapOutcome::Unmappable(failure) => {
                panic!("应当映射成功，实际被拒：{}", failure.code())
            }
        };
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].method, "Page.navigate");
        // 参数必须落到 CDP 的形状上（url 而非 b07 工具面的入参名）。
        assert_eq!(
            steps[0]
                .params
                .as_ref()
                .and_then(|params| params.get("url"))
                .and_then(Value::as_str),
            Some("https://e.com")
        );
    }

    #[test]
    fn 步骤清单渲染方法名与返回内容() {
        let steps = match map_tool_call(
            "mcp__browser__navigate",
            Some(&serde_json::json!({ "sessionId": "s", "url": "https://e.com" })),
        ) {
            ToolMapOutcome::Steps(steps) => steps,
            ToolMapOutcome::Unmappable(failure) => {
                panic!("应当映射成功，实际被拒：{}", failure.code())
            }
        };
        // 一：有返回内容时并入同一行。
        let rendered = render_steps(&steps, &[serde_json::json!({ "frameId": "F1" })]);
        assert!(rendered.contains("[Page.navigate]"));
        assert!(rendered.contains("F1"));
        // 二：返回 null（CDP 对无结果命令返回 {} 或 null）时只留方法名，不写 "null"。
        let bare = render_steps(&steps, &[Value::Null]);
        assert_eq!(bare, "[Page.navigate]");
        // 三：结果数组比步骤短时，缺结果的那步只留方法名——不得因为"没东西可写"
        // 就整段退化成占位文案（方法名是这一步唯一的诊断线索）。
        assert_eq!(render_steps(&steps, &[]), "[Page.navigate]");
        // 四：占位文案只在**一条步骤都没有**时出现（空串在 UI 上看起来像失败）。
        assert_eq!(render_steps(&[], &[]), "（无返回内容）");
    }

    #[test]
    fn 超长结果被按字符截断() {
        let long = "字".repeat(MAX_RESULT_CHARS + 100);
        let result = BrowserToolCallResult::ok(long);
        // 截断后不得切断 UTF-8（能画成字符串即证明没切断）。
        assert!(result.content[0].text.chars().count() < MAX_RESULT_CHARS + 100);
        assert!(result.content[0].text.contains("已截断"));
    }

    #[test]
    fn 内容块类型恒为text() {
        let result = BrowserToolCallResult::ok("x");
        assert_eq!(result.content[0].kind, "text");
        assert_eq!(result.error_code, None);
    }

    /// 极简的块式异步执行器：测试里不能引入 tokio 运行时（本 crate 是 Tauri 库，
    /// 运行时由宿主提供），而 `call_browser_tool` 在未启用后端的路径上
    /// **不会真的 await 任何 IO**（它立刻返回）。用轮询驱动即可。
    fn futures_lite_block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker};
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut pinned = std::pin::pin!(future);
        loop {
            match pinned.as_mut().poll(&mut context) {
                Poll::Ready(output) => return output,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }
}
