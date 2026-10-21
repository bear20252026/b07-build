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

use std::collections::{HashMap, HashSet};
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
/// **只作用于文本块**：图片块被截断就是损坏，见 `BrowserToolContent`。
const MAX_RESULT_CHARS: usize = 128_000;
/// 单张截图 base64 的上限（字符）。超过即**明确报错**，绝不截断。
///
/// 128_000 字符的 base64 约合 96 KB 图片；截图远超这个量级，所以用单独的上限
/// 而不是复用文本上限 —— 复用正是上一版把图片截坏的原因。
const MAX_SCREENSHOT_BASE64_CHARS: usize = 4_000_000;

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

/// 一个内容块（文本或图片）。
///
/// 图片必须是**独立的一类**，不能塞进文本块：截图是 base64，把它当文本走
/// "超长就截断"那条路，截出来的是**不可解码的半个 base64**，而结果仍被标成成功。
/// 那不是压缩，是数据损坏。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolContent {
    /// 块类型：`text` 或 `image`。
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// 文本内容（`text` 块才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 图片的 base64 数据（`image` 块才有）。**从不截断**。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// 图片的 MIME 类型（`image` 块才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

impl BrowserToolContent {
    fn text(text: String) -> Self {
        Self {
            kind: "text",
            text: Some(text),
            data: None,
            mime_type: None,
        }
    }

    fn image(data: String, mime_type: &'static str) -> Self {
        Self {
            kind: "image",
            text: None,
            data: Some(data),
            mime_type: Some(mime_type.to_string()),
        }
    }
}

impl BrowserToolCallResult {
    fn ok(text: impl Into<String>) -> Self {
        Self {
            content: vec![BrowserToolContent::text(truncate(text.into()))],
            is_error: false,
            error_code: None,
        }
    }

    /// 图片结果。**不走 `truncate`** —— 图片数据被截断就是损坏。
    fn ok_image(data: String, mime_type: &'static str) -> Self {
        Self {
            content: vec![BrowserToolContent::image(data, mime_type)],
            is_error: false,
            error_code: None,
        }
    }

    fn err(code: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            content: vec![BrowserToolContent::text(truncate(text.into()))],
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
    /// **后端代际**。每次关闭后端递增。
    ///
    /// 解决的问题：工具调用执行网络操作前会把会话从表里**取出**，结束后再放回。
    /// 若用户在这中间关闭了后端（清空会话表），在途操作结束时又会把连接放回去 ——
    /// 关闭动作找不到这条正在使用的连接，也没法取消它，于是"已关闭"变成一句空话，
    /// 重新启用后旧连接还活着。
    ///
    /// 代际让"放回"变成有条件的：取出时记下代际，放回时若代际已变，说明后端
    /// 在这中间被关过，这条连接**不再属于任何有效的会话**，直接丢弃而不是登记。
    /// 同一代际还在每一步之间被检查，使在途操作在下一个步骤边界就停下（协作式取消）——
    /// 这是不引入取消句柄就能做到的最强保证，且它覆盖的正是"连接已被清空"的场景。
    generation: Mutex<u64>,
    /// 正在执行命令的会话 id（取出后、放回前）。
    ///
    /// 存在的理由：取出期间该 id 不在 `sessions` 里，于是 `close_session` 会回答
    /// "不存在"，`list_sessions` 也看不到它。这两句都是**不准确**的——它既存在，
    /// 也正在工作。有了这张表，两者都能说实话。
    inflight: Mutex<HashSet<String>>,
    /// 在途期间被请求关闭的会话 id。
    ///
    /// 用户既然点了关闭，就不能因为"它正在跑"而静默忽略——那会让关闭看起来成功、
    /// 实际什么也没发生。记在这里，等它跑完**丢弃**而不是放回（等价于延迟关闭）。
    closing: Mutex<HashSet<String>>,
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
            generation: Mutex::new(0),
            inflight: Mutex::new(HashSet::new()),
            closing: Mutex::new(HashSet::new()),
        }
    }

    /// 当前后端代际。工具调用在取出会话前记下它，放回时用来判断后端是否被关过。
    pub fn current_generation(&self) -> Result<u64, &'static str> {
        self.generation
            .lock()
            .map(|generation| *generation)
            .map_err(|_| "browser-backend-state-unavailable")
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
            drop(sessions);
            // 在途会话随代际一起作废，关闭请求与在途标记也一并清掉。
            if let Ok(mut closing) = self.closing.lock() {
                closing.clear();
            }
            let mut generation = self
                .generation
                .lock()
                .map_err(|_| "browser-backend-state-unavailable")?;
            *generation = generation.wrapping_add(1);
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

    // ② 先取后缀：会话生命周期工具**在本地处理**，不能走参数映射。
    //
    // 顺序很重要，且上一版是反的（先映射、后分派）。`close_session` 的公开契约只声明
    // `sessionId`，而它的映射函数要求 `targetId`——于是**按公开契约构造的正常关闭请求
    // 会在这里被 `MissingParameter` 拒掉**，永远走不到下面的本地处理器。
    // 本地处理器本来只需要 `sessionId`（它从会话表里移除条目，连接随条目一起释放），
    // 所以正确的做法是让它先拿到请求，而不是让一个多余的映射挡在前面。
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

    // ③ 其余工具映射为 CDP 步骤（纯函数，失败即拒——不发任何命令）。
    let steps = match map_tool_call(&call.tool_name, call.arguments.as_ref()) {
        ToolMapOutcome::Steps(steps) => steps,
        ToolMapOutcome::Local => {
            // 本地工具已在 ② 分派过。走到这里说明分派表与映射表不一致（代码缺陷），
            // 如实报错而不是当成"成功执行了 0 步"。
            return BrowserToolCallResult::err(
                "browser-local-tool-misrouted",
                format!("工具 {} 应在本地处理，不应走到 CDP 映射路径。", call.tool_name),
            );
        }
        ToolMapOutcome::Unmappable(failure) => {
            return BrowserToolCallResult::err(
                failure.code(),
                format!("工具调用无法映射为 CDP 命令（工具：{}）", call.tool_name),
            )
        }
    };

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
    // 记下取出前的代际：放回时若它变了，说明后端在这中间被关过。
    let generation = match state.current_generation() {
        Ok(generation) => generation,
        Err(code) => {
            return BrowserToolCallResult::err(
                code,
                "后端代际不可读；已按失败处理（fail-closed）。",
            )
        }
    };

    // 标记为在途：让 `close_session` / `list_sessions` 能如实回答"它正在执行命令"，
    // 而不是误报"不存在"。
    if let Ok(mut inflight) = state.inflight.lock() {
        inflight.insert(session_id.clone());
    }

    let mut session = match state.sessions.lock() {
        Ok(mut sessions) => match sessions.remove(&session_id) {
            Some(session) => session,
            None => {
                if let Ok(mut inflight) = state.inflight.lock() {
                    inflight.remove(&session_id);
                }
                return BrowserToolCallResult::err(
                    "browser-session-unknown",
                    format!("不存在该浏览会话：{session_id}"),
                );
            }
        },
        Err(_) => {
            if let Ok(mut inflight) = state.inflight.lock() {
                inflight.remove(&session_id);
            }
            return BrowserToolCallResult::err(
                "browser-backend-state-unavailable",
                "会话表不可读；已按失败处理（fail-closed）。",
            );
        }
    };
    if session.connection.pending_count() >= MAX_INFLIGHT_COMMANDS {
        // 放回表里再报错——否则一次"忙碌"就把会话**弄丢了**。
        // 放回同样要过代际检查：忙碌与关闭同时发生时也不能把旧连接登记回来。
        let _ = restore_session(state, &session_id, session, generation);
        return BrowserToolCallResult::err(
            "browser-session-busy",
            format!("会话 {session_id} 的在途命令已达上限（{MAX_INFLIGHT_COMMANDS}）。"),
        );
    }

    let execution = if suffix == "wait_for" {
        // wait_for 的语义是"轮询到条件成立"，不是一个固定的步骤清单 ——
        // 交给专门的执行器（见 `execute_wait_for`）。
        execute_wait_for(&mut session, call.arguments.as_ref(), state, generation).await
    } else {
        match execute_steps(&mut session, &steps, state, generation).await {
            Ok(collected) => render_tool_result(suffix, &steps, &collected),
            Err(failure) => failure,
        }
    };

    // 无论成功还是失败都要**放回**表里：不放回等于一次失败的调用让会话消失。
    // 但放回是有条件的——后端被关过、或用户在这期间请求了关闭，就不放回。
    let restored = restore_session(state, &session_id, session, generation);
    if let Ok(mut inflight) = state.inflight.lock() {
        inflight.remove(&session_id);
    }
    if !restored {
        // 分两种原因给不同的码：后端整体被关 vs 这个会话被单独关掉。
        let closed_on_request = state
            .closing
            .lock()
            .map(|mut closing| closing.remove(&session_id))
            .unwrap_or(false);
        if closed_on_request {
            return BrowserToolCallResult::err(
                "browser-session-closed",
                format!("会话 {session_id} 已在命令执行期间被关闭；本次命令的结果不再适用。"),
            );
        }
        return BrowserToolCallResult::err(
            "browser-session-discarded",
            format!("后端已关闭，会话 {session_id} 不再登记；本次命令的结果不再适用。"),
        );
    }
    execution
}

/// 把会话放回表中，**仅当后端代际未变**。
///
/// 返回是否放回。代际变了（后端在本次调用期间被关闭）就丢弃：那条连接已经不属于
/// 任何有效会话，登记回去会让"已关闭"变成一句空话，也会让重新启用后残留旧连接。
fn restore_session(
    state: &BrowserToolState,
    session_id: &str,
    session: BrowserSession,
    generation: u64,
) -> bool {
    if !generation_allows_restore(state.current_generation(), generation) {
        return false;
    }
    // 在途期间被请求关闭：不放回（等价于延迟关闭）。用户点了关闭就必须生效，
    // 不能因为"它当时正在跑"而静默忽略——那会让关闭看起来成功、实际什么都没发生。
    if state
        .closing
        .lock()
        .map(|closing| closing.contains(session_id))
        .unwrap_or(true)
    {
        return false;
    }
    state
        .sessions
        .lock()
        .map(|mut sessions| sessions.insert(session_id.to_string(), session))
        .is_ok()
}

/// 代际是否允许把会话放回。
///
/// 抽成纯函数是因为"构造一条真会话"需要活连接，单测里造不出来；而这条判定
/// 恰恰是本项缺陷的核心，必须有牙齿。取值不可读时一律**不放回**（fail-closed）：
/// 判不了就按"后端可能已被关闭"处理，宁可丢一条会话，也不能把连接登记回去。
fn generation_allows_restore(current: Result<u64, &'static str>, taken: u64) -> bool {
    matches!(current, Ok(current) if current == taken)
}

/// 依次执行映射出的 CDP 步骤，收集结果。
///
/// 单独抽出来是为了让"执行"与"会话表管理"两件事分开：前者跨 await，
/// 后者必须尽快释放锁。混在一起是并发缺陷的来源。
///
/// **协作式取消**：每一步之前检查后端代际。代际变了说明后端在本次调用期间被关闭，
/// 立即停止——而不是把剩下的步骤发到一条已经被清空的连接上。这是不引入取消句柄
/// 就能做到的最强保证：取消发生在**步骤边界**，最坏情况是当前这一步跑完。
/// 返回收集到的**原始结果**而不是渲染好的文本：截图必须走图片块，
/// 而"怎么渲染"是调用方的事（见 `render_tool_result`）。
async fn execute_steps(
    session: &mut BrowserSession,
    steps: &[cdp_client::tool_map::CdpStep],
    state: &BrowserToolState,
    generation: u64,
) -> Result<Vec<Value>, BrowserToolCallResult> {
    let mut collected: Vec<Value> = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        if state.current_generation() != Ok(generation) {
            return Err(BrowserToolCallResult::err(
                "browser-session-discarded",
                format!(
                    "后端在命令执行期间被关闭；已在第 {} 步（{}）前中止。",
                    index + 1,
                    step.method
                ),
            ));
        }
        let registered = match session
            .connection
            .send(&step.method, step.params.clone(), None)
            .await
        {
            Ok(registered) => registered,
            Err(error) => {
                return Err(BrowserToolCallResult::err(
                    transport_error_code(&error),
                    format!("发送 {} 失败：{}", step.method, error.detail()),
                ))
            }
        };
        let outcome = match session.connection.await_response(registered.id).await {
            Ok(outcome) => outcome,
            Err(error) => {
                return Err(BrowserToolCallResult::err(
                    transport_error_code(&error),
                    format!("等待 {} 的响应失败：{}", step.method, error.detail()),
                ))
            }
        };
        let value = match outcome {
            cdp_client::frame::CommandOutcome::Ok(value) => value,
            cdp_client::frame::CommandOutcome::Err { code, message } => {
                return Err(BrowserToolCallResult::err(
                    format!("cdp_error_{code}"),
                    format!("CDP 方法 {} 失败：{message}", step.method),
                ))
            }
        };
        // `Runtime.evaluate` 里的 JS 异常**不是** CDP 错误：响应是成功的，
        // 异常挂在 `exceptionDetails` 上。不看它 = 把页面里的报错当成"执行成功"。
        if let Some(details) = value.get("exceptionDetails") {
            return Err(BrowserToolCallResult::err(
                "browser_script_exception",
                format!(
                    "页面脚本在 {} 中抛出异常：{}",
                    step.method,
                    exception_text(details)
                ),
            ));
        }
        // 还有一类"成功响应里的失败"：`Page.navigate` 对**没导航成**的地址
        // （连不上、域名解析不了等）返回的是**成功响应 + `errorText`**（net:: 码），
        // 而不是 CDP 错误。只看 `CommandOutcome` 会把一次**没发生**的导航报成成功。
        //
        // 这条由真实浏览器端到端验证钉住（`real_browser_e2e.rs` 里用"没人监听的
        // 本地端口"触发）。假端点抓不到它：它按我们的理解回话，永远不会自己冒出
        // 一个 `errorText`。
        if let Some(rejected) = rejected_action_text(&value) {
            return Err(BrowserToolCallResult::err(
                "browser_action_rejected",
                format!("CDP 方法 {} 被拒绝：{rejected}", step.method),
            ));
        }
        // 后置动作：依赖这一步的返回值。
        if let Some(follow_up) = step.then.as_ref() {
            if let Err(failure) = apply_follow_up(session, step, follow_up, &value).await {
                return Err(failure);
            }
        }
        collected.push(value);
    }
    Ok(collected)
}

/// 从一条**成功响应**里取出"这个动作其实被拒绝了"的原因。
///
/// CDP 里有两类"成功响应里的失败"：
/// - `Runtime.evaluate` 的 `exceptionDetails`（页面脚本抛异常）；
/// - `Page.navigate` 的 `errorText`（连接被拒、域名解析失败等 net:: 错误）。
///
/// 抽成纯函数是为了可测：真实取值需要活浏览器，而这条判定必须有牙齿。
fn rejected_action_text(value: &Value) -> Option<&str> {
    value
        .get("errorText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

/// 从 `Runtime.evaluate` 的 `exceptionDetails` 里取出可读原因。
fn exception_text(details: &Value) -> String {    if let Some(exception) = details.get("exception") {
        if let Some(description) = exception.get("description").and_then(Value::as_str) {
            return description.to_string();
        }
    }
    details
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("（无描述）")
        .to_string()
}

/// 执行一步的后置动作。返回 `Err` 表示整个工具调用失败。
async fn apply_follow_up(
    session: &mut BrowserSession,
    step: &cdp_client::tool_map::CdpStep,
    follow_up: &cdp_client::tool_map::StepFollowUp,
    value: &Value,
) -> Result<(), BrowserToolCallResult> {
    use cdp_client::tool_map::StepFollowUp;
    match follow_up {
        StepFollowUp::RequireTruthy => {
            if is_truthy_evaluation(value) {
                return Ok(());
            }
            Err(BrowserToolCallResult::err(
                "browser_element_not_found",
                format!(
                    "{} 未找到目标元素（定位脚本返回假值）。已中止，未执行后续输入 —— \
                     否则文本会落到当时恰好获得焦点的别的元素上。",
                    step.method
                ),
            ))
        }
        StepFollowUp::ClickAtReturnedPoint => {
            let Some((x, y)) = returned_point(value) else {
                return Err(BrowserToolCallResult::err(
                    "browser_element_not_found",
                    "未找到目标元素（定位脚本没有返回坐标）；未发生点击。".to_string(),
                ));
            };
            click_at(session, x, y).await
        }
    }
}

/// `Runtime.evaluate` 的返回值是否为真值。
///
/// 取 `result.value`（`returnByValue: true` 时脚本的返回值就在这里）。
/// 形状不符一律按**假值**处理：宁可误判为"没找到"而中止，也不能把"没找到"
/// 误判成"找到了"继续往下输入。
fn is_truthy_evaluation(value: &Value) -> bool {
    match value.get("result").and_then(|result| result.get("value")) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Null) | None => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(_)) => true,
    }
}

/// 从定位脚本的返回值里取坐标。
fn returned_point(value: &Value) -> Option<(f64, f64)> {
    let point = value.get("result")?.get("value")?;
    let x = point.get("x")?.as_f64()?;
    let y = point.get("y")?.as_f64()?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some((x, y))
}

/// 在视口坐标 `(x, y)` 处派发一次完整的左键点击（按下 + 抬起）。
///
/// 只发 `mousePressed` 会让页面停在"按住"状态（某些拖拽逻辑会被触发），
/// 只发 `mouseReleased` 则不会被任何元素认领。两次都必须发，且 `clickCount: 1`。
async fn click_at(
    session: &mut BrowserSession,
    x: f64,
    y: f64,
) -> Result<(), BrowserToolCallResult> {
    for event_type in ["mousePressed", "mouseReleased"] {
        let params = serde_json::json!({
            "type": event_type,
            "x": x,
            "y": y,
            "button": "left",
            "clickCount": 1,
        });
        let registered = match session
            .connection
            .send("Input.dispatchMouseEvent", Some(params), None)
            .await
        {
            Ok(registered) => registered,
            Err(error) => {
                return Err(BrowserToolCallResult::err(
                    transport_error_code(&error),
                    format!("发送鼠标事件（{event_type}）失败：{}", error.detail()),
                ))
            }
        };
        match session.connection.await_response(registered.id).await {
            Ok(cdp_client::frame::CommandOutcome::Ok(_)) => {}
            Ok(cdp_client::frame::CommandOutcome::Err { code, message }) => {
                return Err(BrowserToolCallResult::err(
                    format!("cdp_error_{code}"),
                    format!("鼠标事件（{event_type}）失败：{message}"),
                ))
            }
            Err(error) => {
                return Err(BrowserToolCallResult::err(
                    transport_error_code(&error),
                    format!("等待鼠标事件（{event_type}）的响应失败：{}", error.detail()),
                ))
            }
        }
    }
    Ok(())
}

/// 发送一条 `Runtime.evaluate` 并返回其 `result.value`。
///
/// 页面脚本抛异常时返回 `Err`：`exceptionDetails` 是**成功响应**里的失败信号，
/// 不看它就会把页面里的报错当成"执行成功"。
async fn evaluate(
    session: &mut BrowserSession,
    expression: &str,
) -> Result<Value, BrowserToolCallResult> {
    let params = serde_json::json!({ "expression": expression, "returnByValue": true });
    let registered = match session
        .connection
        .send("Runtime.evaluate", Some(params), None)
        .await
    {
        Ok(registered) => registered,
        Err(error) => {
            return Err(BrowserToolCallResult::err(
                transport_error_code(&error),
                format!("发送 Runtime.evaluate 失败：{}", error.detail()),
            ))
        }
    };
    let value = match session.connection.await_response(registered.id).await {
        Ok(cdp_client::frame::CommandOutcome::Ok(value)) => value,
        Ok(cdp_client::frame::CommandOutcome::Err { code, message }) => {
            return Err(BrowserToolCallResult::err(
                format!("cdp_error_{code}"),
                format!("Runtime.evaluate 失败：{message}"),
            ))
        }
        Err(error) => {
            return Err(BrowserToolCallResult::err(
                transport_error_code(&error),
                format!("等待 Runtime.evaluate 的响应失败：{}", error.detail()),
            ))
        }
    };
    if let Some(details) = value.get("exceptionDetails") {
        return Err(BrowserToolCallResult::err(
            "browser_script_exception",
            format!("页面脚本抛出异常：{}", exception_text(details)),
        ));
    }
    Ok(value.get("result").and_then(|result| result.get("value")).cloned().unwrap_or(Value::Null))
}

/// 等待的默认与上限（毫秒）。上限存在是为了不让一次工具调用把整个回合挂死。
const WAIT_FOR_DEFAULT_TIMEOUT_MS: u64 = 10_000;
const WAIT_FOR_MAX_TIMEOUT_MS: u64 = 60_000;
/// 轮询间隔。CDP 没有"等条件成立"的原语，只能自己轮询。
const WAIT_FOR_POLL_INTERVAL_MS: u64 = 120;

/// `wait_for`：**真的等**到条件成立，或到超时为止。
///
/// 上一版只查一次就返回（文本）、只读一次 URL 却不比较、只有 `timeoutMs` 时
/// 干脆返回空步骤 —— 三种情况都会让调用方以为"等到了"。等待类工具的核心语义
/// 就是"没等到要说没等到"，因此这里必须轮询到截止时间并在超时时**明确失败**。
async fn execute_wait_for(
    session: &mut BrowserSession,
    arguments: Option<&Value>,
    state: &BrowserToolState,
    generation: u64,
) -> BrowserToolCallResult {
    let params = arguments.and_then(Value::as_object);
    let text = params
        .and_then(|map| map.get("text"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let url = params
        .and_then(|map| map.get("url"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let timeout_ms = params
        .and_then(|map| map.get("timeoutMs"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value as u64)
        .unwrap_or(WAIT_FOR_DEFAULT_TIMEOUT_MS)
        .min(WAIT_FOR_MAX_TIMEOUT_MS);

    // 只有 timeoutMs：纯等待。上一版返回空步骤列表，执行器把它当成"成功执行了 0 步"。
    if text.is_none() && url.is_none() {
        tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
        return BrowserToolCallResult::ok(format!("已等待 {timeout_ms} 毫秒。"));
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let mut attempts: u32 = 0;
    loop {
        if state.current_generation() != Ok(generation) {
            return BrowserToolCallResult::err(
                "browser-session-discarded",
                "后端在等待期间被关闭；已中止等待。",
            );
        }
        attempts += 1;
        if let Some(text) = text.as_deref() {
            let expression = format!(
                "!!(document.body && document.body.innerText && document.body.innerText.includes({t}))",
                t = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
            );
            match evaluate(session, &expression).await {
                Ok(value) => {
                    if matches!(value, Value::Bool(true)) {
                        return BrowserToolCallResult::ok(format!(
                            "文本已出现（{attempts} 次轮询后）：{text}"
                        ));
                    }
                }
                Err(failure) => return failure,
            }
        } else if let Some(expected) = url.as_deref() {
            match evaluate(session, "location.href").await {
                Ok(Value::String(current)) => {
                    if url_matches(&current, expected) {
                        return BrowserToolCallResult::ok(format!(
                            "已到达目标地址（{attempts} 次轮询后）：{current}"
                        ));
                    }
                }
                Ok(_) => {
                    return BrowserToolCallResult::err(
                        "browser_url_unreadable",
                        "无法读取当前地址；已按失败处理。".to_string(),
                    )
                }
                Err(failure) => return failure,
            }
        }
        if std::time::Instant::now() >= deadline {
            let condition = match (text.as_deref(), url.as_deref()) {
                (Some(text), _) => format!("文本「{text}」"),
                (_, Some(url)) => format!("地址「{url}」"),
                _ => "条件".to_string(),
            };
            return BrowserToolCallResult::err(
                "browser_wait_timeout",
                format!("等待超时（{timeout_ms} 毫秒，{attempts} 次轮询）：{condition} 未出现。"),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(WAIT_FOR_POLL_INTERVAL_MS)).await;
    }
}

/// 当前地址是否满足等待目标。
///
/// 用**前缀**匹配：调用方写 `https://example.com` 时，实际落到的
/// `https://example.com/path?q=1` 应当算到达（这正是"等它导航过去"的常见用法）。
/// 精确相等是前缀匹配的特例，故不必单独判。
fn url_matches(current: &str, expected: &str) -> bool {
    current == expected || current.starts_with(expected)
}


/// 把收集到的原始结果渲染成工具返回值。
///
/// 截图走**图片块**，其余走文本块。这一步是"图片不能被当文本截断"的落点：
/// 上一版把 `Page.captureScreenshot` 的 base64 序列化成文本再统一截断到 128_000
/// 字符，超限时得到的是**不可解码的半个 base64**，而结果仍被标成成功。
fn render_tool_result(
    suffix: &str,
    steps: &[cdp_client::tool_map::CdpStep],
    collected: &[Value],
) -> BrowserToolCallResult {
    if suffix == "take_screenshot" {
        let Some(data) = collected
            .last()
            .and_then(|value| value.get("data"))
            .and_then(Value::as_str)
        else {
            return BrowserToolCallResult::err(
                "browser_screenshot_missing_data",
                "截图响应里没有 data 字段；未返回任何图片。".to_string(),
            );
        };
        if data.len() > MAX_SCREENSHOT_BASE64_CHARS {
            // 明确报错，**不截断**：截断产出的是坏数据，且调用方无从察觉。
            return BrowserToolCallResult::err(
                "browser_screenshot_too_large",
                format!(
                    "截图过大（{} 字符，上限 {MAX_SCREENSHOT_BASE64_CHARS}）；已拒绝返回损坏的数据。\
                     请缩小视口或改用 snapshot 获取文本结构。",
                    data.len()
                ),
            );
        }
        return BrowserToolCallResult::ok_image(data.to_string(), "image/png");
    }
    BrowserToolCallResult::ok(render_steps(steps, collected))
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
        // 空表不等于"没有会话"：在途的那条被临时取出了。如实区分这两种情况。
        let inflight = state
            .inflight
            .lock()
            .map(|inflight| {
                let mut ids: Vec<String> = inflight.iter().cloned().collect();
                ids.sort();
                ids
            })
            .unwrap_or_default();
        if inflight.is_empty() {
            return BrowserToolCallResult::ok("当前没有浏览会话。");
        }
        let lines: Vec<String> = inflight
            .iter()
            .map(|id| format!("{id} · 正在执行命令"))
            .collect();
        return BrowserToolCallResult::ok(lines.join("\n"));
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
    if sessions.remove(&session_id).is_some() {
        return BrowserToolCallResult::ok(format!("已关闭浏览会话 {session_id}。"));
    }
    drop(sessions);
    // 不在表里但**在途**：它正在执行命令。不能说"不存在"（那是错的），
    // 也不能静默忽略（用户点了关闭就该生效）——记下关闭请求，等它跑完不放回。
    let inflight = state
        .inflight
        .lock()
        .map(|inflight| inflight.contains(&session_id))
        .unwrap_or(false);
    if inflight {
        if state
            .closing
            .lock()
            .map(|mut closing| closing.insert(session_id.clone()))
            .is_err()
        {
            return BrowserToolCallResult::err(
                "browser-backend-state-unavailable",
                "关闭请求无法登记；已按失败处理（fail-closed）。",
            );
        }
        return BrowserToolCallResult::ok(format!(
            "会话 {session_id} 正在执行命令；已登记关闭请求，将在当前命令结束后关闭。"
        ));
    }
    BrowserToolCallResult::err(
        "browser-session-unknown",
        format!("不存在该浏览会话：{session_id}"),
    )
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

/// 一条**活动**浏览会话的对外视图。
///
/// 只给标识符与状态，不含页面内容 —— 这个面板回答的是"现在开着哪些会话"，
/// 不是"页面里有什么"。
#[derive(Debug, Clone, Serialize)]
pub struct BrowserSessionSummary {
    /// 会话 id（工具面里用的那个）。
    pub session_id: String,
    /// 已配对的目标（tab）id。**在途会话取不到** —— 那段时间它被从表里取出去执行命令了。
    pub target_id: Option<String>,
    /// `active` / `inflight` / `closing`。
    ///
    /// 三种必须分开：`active` 能正常用；`inflight` 正在执行命令，此时点关闭是
    /// "延迟关闭"而不是失败；`closing` 已被请求关闭，跑完就消失。
    pub status: String,
}

/// 把三份状态合成对外视图。**纯函数**，故可单测 —— 命令本身只负责加锁取值。
///
/// `active` 是 `(session_id, target_id)`；`inflight` 是"正在执行命令、已从表里取出"的 id；
/// `closing` 是"已请求关闭"的 id。
fn summarize_sessions(
    active: &[(String, String)],
    inflight: &HashSet<String>,
    closing: &HashSet<String>,
) -> Vec<BrowserSessionSummary> {
    let mut summaries: Vec<BrowserSessionSummary> = Vec::new();
    let mut known: HashSet<&str> = HashSet::new();
    for (session_id, target_id) in active {
        known.insert(session_id.as_str());
        summaries.push(BrowserSessionSummary {
            session_id: session_id.clone(),
            target_id: Some(target_id.clone()),
            status: if closing.contains(session_id) { "closing" } else { "active" }.to_owned(),
        });
    }
    // 在途会话不在 `active` 里（被取出去执行命令了），但**确实存在**。
    // 漏掉它们会让界面在"有会话正在跑"的那一刻显示"没有会话"——
    // 而那正是用户最需要看到真实状态的时刻。
    let mut inflight_ids: Vec<&String> = inflight.iter().collect();
    inflight_ids.sort();
    for session_id in inflight_ids {
        if known.contains(session_id.as_str()) {
            continue;
        }
        summaries.push(BrowserSessionSummary {
            session_id: session_id.clone(),
            target_id: None,
            status: "inflight".to_owned(),
        });
    }
    summaries.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    summaries
}

/// 列出活动浏览会话（**给界面用的结构**）。
///
/// 与 `list_sessions` 工具的区别：那个返回给模型读的**文本**，这个返回给界面用的**结构**。
/// 两者读同一份状态，所以不会出现"工具说有三个、界面说没有"。
#[tauri::command]
pub fn browser_sessions_list(
    state: tauri::State<'_, BrowserToolState>,
) -> Result<Vec<BrowserSessionSummary>, &'static str> {
    let closing = state
        .closing
        .lock()
        .map(|set| set.clone())
        .unwrap_or_default();

    let active: Vec<(String, String)> = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "browser-backend-state-unavailable")?;
        sessions
            .iter()
            .map(|(session_id, session)| (session_id.clone(), session.target_id.clone()))
            .collect()
        // 锁在这里释放：下面要读 inflight，不持有两把锁可以避开锁序问题。
    };

    let inflight = state
        .inflight
        .lock()
        .map(|set| set.clone())
        .unwrap_or_default();

    Ok(summarize_sessions(&active, &inflight, &closing))
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
    fn 关闭在途会话会登记关闭请求而不是误报不存在() {
        // 复现缺陷的交错：会话被取出执行命令 → 用户请求关闭。
        // 上一版回答"不存在"（错的：它存在且正在工作），且关闭**不生效**——
        // 命令跑完后连接又被放回，用户的关闭请求被静默丢弃。
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        state.inflight.lock().unwrap().insert("s1".to_string());
        let result = close_session(&state, Some(&serde_json::json!({ "sessionId": "s1" })));
        assert!(!result.is_error, "在途会话的关闭请求应被接受：{:?}", result.content[0].text);
        assert!(state.closing.lock().unwrap().contains("s1"), "关闭请求必须被登记");
    }

    #[test]
    fn 既不在表也不在途的会话仍报不存在() {
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        let result = close_session(&state, Some(&serde_json::json!({ "sessionId": "nope" })));
        assert!(result.is_error);
        assert_eq!(result.error_code.as_deref(), Some("browser-session-unknown"));
    }

    #[test]
    fn 只有关闭会话时列表如实报告它在执行命令() {
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        assert_eq!(list_sessions(&state).content[0].text.as_deref(), Some("当前没有浏览会话。"));
        state.inflight.lock().unwrap().insert("s1".to_string());
        let text = list_sessions(&state).content[0].text.clone().unwrap_or_default();
        // 空表 ≠ 没有会话：在途那条被临时取出了，必须如实区分。
        assert!(text.contains("s1"), "应列出在途会话，实际：{text}");
        assert!(text.contains("正在执行命令"), "应说明它在执行命令，实际：{text}");
    }

    #[test]
    fn 关闭后端会清掉关闭请求() {
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        state.inflight.lock().unwrap().insert("s1".to_string());
        close_session(&state, Some(&serde_json::json!({ "sessionId": "s1" })));
        assert_eq!(state.closing.lock().unwrap().len(), 1);
        state.set_enabled(false).unwrap();
        // 关闭后端已经让一切作废，残留的关闭请求会在下次启用后误伤同名会话。
        assert!(state.closing.lock().unwrap().is_empty(), "关闭后端应清掉关闭请求");
    }

    #[test]
    fn 关闭后端会推进代际而启用不会() {
        // 代际是"在途操作能否回登记"的唯一判据：关闭必须推进它。
        // 启用不推进——否则每次开关都会让在途操作白跑。
        let state = BrowserToolState::new();
        let initial = state.current_generation().unwrap();
        state.set_enabled(true).unwrap();
        assert_eq!(state.current_generation().unwrap(), initial, "启用不应推进代际");
        state.set_enabled(false).unwrap();
        assert_eq!(state.current_generation().unwrap(), initial + 1);
        state.set_enabled(false).unwrap();
        assert_eq!(state.current_generation().unwrap(), initial + 2, "再次关闭继续推进");
    }

    #[test]
    fn 代际未变才允许放回会话() {
        assert!(generation_allows_restore(Ok(7), 7), "同代际应放回");
        assert!(!generation_allows_restore(Ok(8), 7), "代际变了必须丢弃");
        assert!(!generation_allows_restore(Err("x"), 7), "读不到代际时按不可放回处理（fail-closed）");
    }

    #[test]
    fn 关闭后端后在途操作的回登记被拒() {
        // 复现缺陷的交错：取出会话（代际 g）→ 后端被关 → 操作结束试图放回。
        // 上一版无条件放回，于是"已关闭"变成一句空话；现在必须被拒。
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        let taken = state.current_generation().unwrap();
        state.set_enabled(false).unwrap();
        assert!(
            !generation_allows_restore(state.current_generation(), taken),
            "关闭后旧代际的会话不得回登记"
        );
    }

    #[test]
    fn 未关闭时在途操作仍可回登记() {
        // 反向钉子：不能因为加了守卫就把正常路径也堵死。
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        let taken = state.current_generation().unwrap();
        assert!(generation_allows_restore(state.current_generation(), taken));
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
        // ① 会话生命周期分派（步骤 ②）与参数映射（步骤 ③）都发生在会话查表（步骤 ④）**之前**，
        //    故映射错误会先报；
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
    fn 关闭会话只带session_id即可走通公开契约() {
        // 本项缺陷的回归钉：公开契约只声明 sessionId，而映射层曾要求 targetId，
        // 于是**按公开契约构造的正常关闭请求**在映射处被拒，永远到不了本地处理器。
        // 现在它必须走到本地处理器，报的是"会话不存在"（因为表是空的），
        // 而**不是** `tool_map_missing_parameter:targetId`。
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        let result = futures_lite_block_on(call_browser_tool(
            &state,
            BrowserToolCallRequest {
                tool_name: "mcp__browser__close_session".to_string(),
                arguments: Some(serde_json::json!({ "sessionId": "s" })),
            },
        ));
        assert!(result.is_error);
        assert_eq!(
            result.error_code.as_deref(),
            Some("browser-session-unknown"),
            "应走到本地处理器；若报 tool_map_missing_parameter 说明映射又挡在了前面"
        );
    }

    #[test]
    fn 本地工具不会走到cdp映射路径() {
        // 分派表与映射表必须一致：本地工具在分派处就返回，不该落到映射分支。
        // 若落到那里，会报 browser-local-tool-misrouted（而不是静默当成"执行了 0 步"）。
        //
        // 这里只覆盖 list_sessions 与 close_session：create_session 会做真实的端点发现
        // （网络 IO），需要 Tokio 反应堆，本文件的 block_on 替身没有。
        // create_session 的"判为本地"由 `cdp-client` 的
        // `会话生命周期工具判为本地处理而非步骤` 在纯映射层钉住。
        for name in ["list_sessions", "close_session"] {
            let state = BrowserToolState::new();
            state.set_enabled(true).unwrap();
            let result = futures_lite_block_on(call_browser_tool(
                &state,
                BrowserToolCallRequest {
                    tool_name: format!("mcp__browser__{name}"),
                    arguments: None,
                },
            ));
            assert_ne!(
                result.error_code.as_deref(),
                Some("browser-local-tool-misrouted"),
                "{name} 不应走到映射路径"
            );
        }
    }

    #[test]
    fn 列表会话不带任何参数也能成功() {
        // 公开声明里 list_sessions 没有参数，本地处理器也不要求参数。
        let state = BrowserToolState::new();
        state.set_enabled(true).unwrap();
        let result = futures_lite_block_on(call_browser_tool(
            &state,
            BrowserToolCallRequest {
                tool_name: "mcp__browser__list_sessions".to_string(),
                arguments: None,
            },
        ));
        assert!(!result.is_error, "list_sessions 不应失败");
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
            // navigate 不是本地工具；判 Local 说明分派表被改错了。
            ToolMapOutcome::Local => panic!("navigate 不应判为本地工具"),
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
            // navigate 不是本地工具；判 Local 说明分派表被改错了。
            ToolMapOutcome::Local => panic!("navigate 不应判为本地工具"),
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
    fn 会话摘要区分可用与正在关闭() {
        let active = vec![
            ("s2".to_owned(), "tab-2".to_owned()),
            ("s1".to_owned(), "tab-1".to_owned()),
        ];
        let closing: std::collections::HashSet<String> = ["s2".to_owned()].into_iter().collect();
        let summaries = summarize_sessions(&active, &std::collections::HashSet::new(), &closing);
        // 按会话 id 排序，界面顺序稳定。
        assert_eq!(summaries.iter().map(|item| item.session_id.as_str()).collect::<Vec<_>>(), vec!["s1", "s2"]);
        assert_eq!(summaries[0].status, "active");
        assert_eq!(summaries[0].target_id.as_deref(), Some("tab-1"));
        // 已请求关闭的会话仍在表里，但状态必须是 closing —— 否则用户会以为它还能用。
        assert_eq!(summaries[1].status, "closing");
    }

    #[test]
    fn 在途会话也要列出来且没有目标() {
        // 在途会话被从 sessions 表里取出去执行命令了。若因为它"不在表里"就不列，
        // 界面会在"有会话正在跑"的那一刻显示"没有会话"—— 那是最容易误判的时刻。
        let inflight: std::collections::HashSet<String> = ["s9".to_owned()].into_iter().collect();
        let summaries = summarize_sessions(&[], &inflight, &std::collections::HashSet::new());
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].status, "inflight");
        // 目标在取出期间读不到，如实给 None，而不是编一个。
        assert_eq!(summaries[0].target_id, None);
    }

    #[test]
    fn 同时在表里与在途时不重复列出() {
        let active = vec![("s1".to_owned(), "tab-1".to_owned())];
        let inflight: std::collections::HashSet<String> = ["s1".to_owned()].into_iter().collect();
        let summaries = summarize_sessions(&active, &inflight, &std::collections::HashSet::new());
        assert_eq!(summaries.len(), 1, "同一条会话不该出现两次");
        assert_eq!(summaries[0].status, "active");
    }

    #[test]
    fn 动作被拒绝时能从成功响应里认出来() {
        // `Page.navigate` 把"被拒绝"报在结果里的 errorText，而不是 CDP 错误。
        // 只判 CommandOutcome 会把一次没发生的导航报成成功。
        assert_eq!(
            rejected_action_text(&serde_json::json!({ "errorText": "net::ERR_ABORTED" })),
            Some("net::ERR_ABORTED")
        );
        // 正常导航的结果里没有 errorText。
        assert_eq!(rejected_action_text(&serde_json::json!({ "frameId": "F1" })), None);
        // 空串不算拒绝（有些实现会带一个空的 errorText）。
        assert_eq!(rejected_action_text(&serde_json::json!({ "errorText": "   " })), None);
        assert_eq!(rejected_action_text(&serde_json::json!({})), None);
        // 形状不符按"没有拒绝"处理：不能因为字段类型不对就把正常导航判成失败。
        assert_eq!(rejected_action_text(&serde_json::json!({ "errorText": 42 })), None);
    }

    #[test]
    fn 真值判定按脚本返回值() {
        // 定位脚本找不到元素时返回 false —— 必须被认出来，否则会继续往下输入。
        assert!(!is_truthy_evaluation(&serde_json::json!({ "result": { "value": false } })));
        assert!(is_truthy_evaluation(&serde_json::json!({ "result": { "value": true } })));
        // 形状不符一律按假值处理：宁可误判为"没找到"而中止，也不能误判成"找到了"。
        assert!(!is_truthy_evaluation(&serde_json::json!({})));
        assert!(!is_truthy_evaluation(&serde_json::json!({ "result": {} })));
        assert!(!is_truthy_evaluation(&serde_json::json!({ "result": { "value": null } })));
        assert!(!is_truthy_evaluation(&serde_json::json!({ "result": { "value": 0 } })));
        assert!(!is_truthy_evaluation(&serde_json::json!({ "result": { "value": "" } })));
        assert!(is_truthy_evaluation(&serde_json::json!({ "result": { "value": 1 } })));
        assert!(is_truthy_evaluation(&serde_json::json!({ "result": { "value": "x" } })));
    }

    #[test]
    fn 坐标解析要求有限数() {
        assert_eq!(
            returned_point(&serde_json::json!({ "result": { "value": { "x": 1.5, "y": 2.5 } } })),
            Some((1.5, 2.5))
        );
        // null（元素没找到）不得被当成 (0,0) —— 那会在页面左上角点一下。
        assert_eq!(returned_point(&serde_json::json!({ "result": { "value": null } })), None);
        assert_eq!(returned_point(&serde_json::json!({ "result": { "value": { "x": 1 } } })), None);
        assert_eq!(
            returned_point(&serde_json::json!({ "result": { "value": { "x": 1, "y": "2" } } })),
            None
        );
    }

    #[test]
    fn 脚本异常文本优先取描述() {
        assert_eq!(
            exception_text(&serde_json::json!({
                "exception": { "description": "TypeError: x is not a function" },
                "text": "Uncaught"
            })),
            "TypeError: x is not a function"
        );
        assert_eq!(exception_text(&serde_json::json!({ "text": "Uncaught" })), "Uncaught");
        assert_eq!(exception_text(&serde_json::json!({})), "（无描述）");
    }

    #[test]
    fn 地址等待用前缀匹配() {
        assert!(url_matches("https://e.com/a?b=1", "https://e.com"));
        assert!(url_matches("https://e.com", "https://e.com"));
        // 不能反向：期望的是具体地址时，"已经在别的页面"不算到达。
        assert!(!url_matches("https://e.com", "https://e.com/a"));
        assert!(!url_matches("https://other.test", "https://e.com"));
    }

    /// 造一条步骤（`CdpStep::new` 是映射模块的私有构造，这里直接写字段）。
    fn step(method: &str) -> cdp_client::tool_map::CdpStep {
        cdp_client::tool_map::CdpStep {
            method: method.to_string(),
            params: None,
            then: None,
        }
    }

    #[test]
    fn 截图渲染成图片块而不是文本块() {
        let steps = vec![step("Page.captureScreenshot")];
        let result = render_tool_result(
            "take_screenshot",
            &steps,
            &[serde_json::json!({ "data": "AAAA" })],
        );
        assert!(!result.is_error);
        assert_eq!(result.content[0].kind, "image");
        assert_eq!(result.content[0].data.as_deref(), Some("AAAA"));
        assert_eq!(result.content[0].mime_type.as_deref(), Some("image/png"));
        assert_eq!(result.content[0].text, None, "图片块不应带 text");
    }

    #[test]
    fn 截图缺少data时明确报错() {
        let steps = vec![step("Page.captureScreenshot")];
        let result = render_tool_result("take_screenshot", &steps, &[serde_json::json!({})]);
        assert!(result.is_error);
        assert_eq!(
            result.error_code.as_deref(),
            Some("browser_screenshot_missing_data")
        );
    }

    #[test]
    fn 截图超限时明确报错而不是截断() {
        // 上一版把 base64 当文本截断到 128_000 字符：产出不可解码的半个 base64，
        // 而结果仍被标成成功。那不是压缩，是数据损坏。
        let steps = vec![step("Page.captureScreenshot")];
        let huge = "A".repeat(MAX_SCREENSHOT_BASE64_CHARS + 1);
        let result = render_tool_result(
            "take_screenshot",
            &steps,
            &[serde_json::json!({ "data": huge })],
        );
        assert!(result.is_error);
        assert_eq!(
            result.error_code.as_deref(),
            Some("browser_screenshot_too_large")
        );
        assert_eq!(result.content[0].kind, "text");
    }

    #[test]
    fn 图片块从不被截断() {
        // 直接构造一个超长图片块：ok_image 不走 truncate。
        let data = "B".repeat(MAX_RESULT_CHARS * 2);
        let result = BrowserToolCallResult::ok_image(data.clone(), "image/png");
        assert_eq!(result.content[0].data.as_deref(), Some(data.as_str()));
    }

    #[test]
    fn 非截图工具仍走文本块() {
        let steps = vec![step("Page.navigate")];
        let result = render_tool_result("navigate", &steps, &[serde_json::json!({ "frameId": "F" })]);
        assert!(!result.is_error);
        assert_eq!(result.content[0].kind, "text");
        assert_eq!(result.content[0].data, None);
    }

    #[test]
    fn 超长结果被按字符截断() {
        let long = "字".repeat(MAX_RESULT_CHARS + 100);
        let result = BrowserToolCallResult::ok(long);
        // 截断后不得切断 UTF-8（能画成字符串即证明没切断）。
        let text = result.content[0].text.clone().unwrap_or_default();
        assert!(text.chars().count() < MAX_RESULT_CHARS + 100);
        assert!(text.contains("已截断"));
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
