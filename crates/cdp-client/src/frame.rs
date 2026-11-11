//! CDP 帧纪律：构造命令、解析入站帧、把响应匹配回发出它的命令。
//!
//! ## 为什么需要一个专门的模块
//!
//! CDP 的 WebSocket 是**全双工单通道**：命令的响应与主动推送的事件走同一条连接，
//! 都可能**乱序**到达。协议本身只用两个字段区分它们：
//!
//! - 带 `id` 的帧 = 某个命令的响应（`result` 或 `error`）
//! - 不带 `id` 的帧 = 事件（`method` + `params`）
//!
//! 这个判据只有一条，且必须**只看 `id` 在不在**，不能看字段名像不像。常见的错误
//! 写法是"有 `result` 就当响应"——但事件也可能带一个叫 `result` 的参数字段；反过来
//! "有 `method` 就当事件"也不行，因为错误响应在某些实现里会回带 `method`。
//!
//! ## 本模块的边界
//!
//! 纯函数：不持有连接、不读时钟、不做 IO。`next_command_id` 是一个显式的计数器类型，
//! 由调用方持有——本模块只负责"给定状态与输入，算出下一个状态与输出"。

use serde::Serialize;
use serde_json::{Map, Value};

/// 一条命令的请求 id。CDP 要求同一连接内唯一；用 `u64` 单调递增即可。
///
/// 刻意做成 newtype 而非裸 `u64`：`id` 与"第几条命令"、"标签页下标"、"超时毫秒"
/// 都是整数，混用时编译器帮不上忙，而错用会表现为**结果错投给另一条命令**——
/// 一个静默错结果的缺陷，不是崩溃。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct CommandId(pub u64);

impl CommandId {
    /// 取出底层数值（序列化进帧时用）。
    pub fn get(self) -> u64 {
        self.0
    }
}

/// 命令 id 分配器。从 1 开始——**0 保留**，因为 0 在部分实现里表示"未指定"。
#[derive(Debug, Clone)]
pub struct CommandIdAllocator {
    next: u64,
}

impl Default for CommandIdAllocator {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandIdAllocator {
    /// 从 1 开始分配。
    pub fn new() -> Self {
        Self { next: 1 }
    }

    /// 分配下一个 id。`u64::MAX` 之后回绕到 1 而不是 0——`0` 永不被分配。
    pub fn allocate(&mut self) -> CommandId {
        let id = self.next;
        self.next = if self.next == u64::MAX {
            1
        } else {
            self.next + 1
        };
        CommandId(id)
    }
}

/// 一条待发出的 CDP 命令。
///
/// `params` 用 `Value` 而非泛型：CDP 有 40+ 个方法、每个的参数结构都不同，为每个
/// 方法建一个结构体会让"加一个方法"变成"改四处"，而这些结构体本身没有任何判定
/// 逻辑——是纯粹的形状转写。校验发生在更有价值的地方（工具入参 schema），不在这里。
///
/// ## `session_id` 为什么必须是**顶层**字段
///
/// CDP 的扁平会话模型（flat session）规定：命令的目标会话由**与 `id`、`method` 并列
/// 的顶层 `sessionId`** 表达。把它塞进 `params` 不是"换了个地方放"——对端根本不把
/// `params.sessionId` 当路由信息看，它会认为这条命令没有指定会话，于是命令落在
/// **浏览器级**会话上：轻则报"方法不存在"，重则作用到错误的上下文（例如
/// `Runtime.evaluate` 在浏览器级执行，而不是在那个已 attach 的页面里）。
///
/// 这个错误还有个隐蔽之处：它**不会**在连接层报错，只会在语义层静默走偏。因此
/// `CommandFrame` 把它做成一个显式字段，而不是让调用方自己往 `params` 里塞。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandFrame {
    /// 请求 id，唯一。
    pub id: CommandId,
    /// CDP 方法名，如 `Page.navigate`、`Runtime.evaluate`。
    pub method: String,
    /// 方法参数；无参数时省略而不是发 `null`（部分实现拒收显式 `null`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// 目标会话 id。**与 `id`、`method` 并列在顶层**，绝不并入 `params`。
    ///
    /// 字段名按 CDP 的驼峰惯例序列化为 `sessionId`。
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl CommandFrame {
    /// 构造一条**无目标会话**的命令（浏览器级）。
    pub fn new(id: CommandId, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            id,
            method: method.into(),
            params,
            session_id: None,
        }
    }

    /// 构造一条**带目标会话**的命令：`sessionId` 位于顶层，与 `id`/`method` 并列。
    ///
    /// 用构造函数而不是让调用方自己改字段，是为了让"会话要放顶层"这件事只有一个
    /// 落点——上一版的缺陷正是散落在 `encode_command` 里的一段 `map.insert`。
    pub fn with_session(
        id: CommandId,
        method: impl Into<String>,
        params: Option<Value>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            id,
            method: method.into(),
            params,
            session_id: Some(session_id.into()),
        }
    }

    /// 序列化成一行 JSON 文本（WebSocket 文本帧即此内容）。
    pub fn encode(&self) -> Result<String, FrameError> {
        if self.method.trim().is_empty() {
            return Err(FrameError::EmptyMethod);
        }
        // 空串会话 id 会被对端当作"没有会话"或直接拒收，两种都不是调用方想要的：
        // 拒绝而不是发出一条语义不明的命令。
        if let Some(session_id) = self.session_id.as_deref() {
            if session_id.trim().is_empty() {
                return Err(FrameError::EmptySessionId);
            }
        }
        serde_json::to_string(self).map_err(|error| FrameError::Encode(error.to_string()))
    }
}

/// 一条入站帧的分类结果。
///
/// 三类之间**互斥且穷尽**：任何一条合法 CDP 帧必然落入其中之一，任何不落入的
/// 帧都会被判为 `Invalid` 而不是被静默忽略——静默忽略会让调用方等一个永远不会
/// 到达的响应，直到超时。
#[derive(Debug, Clone, PartialEq)]
pub enum InboundFrame {
    /// 某个命令的**成功**响应。
    Response {
        /// 对应的命令 id。
        id: CommandId,
        /// 结果载荷；缺失按 `null` 处理（部分方法成功时无 result 字段）。
        result: Value,
    },
    /// 某个命令的**失败**响应。错误必须原样上抛，不能被当作空结果吞掉——
    /// 把失败当成功是浏览器自动化里最贵的一类缺陷（后续步骤全在错的页面上跑）。
    Failure {
        /// 对应的命令 id。
        id: CommandId,
        /// CDP 错误码（整数，`-32000` 一类）。
        code: i64,
        /// 可读原因。
        message: String,
    },
    /// 浏览器主动推送的事件（无 `id`）。
    Event {
        /// 事件方法名，如 `Page.loadEventFired`。
        method: String,
        /// 事件参数；缺失按 `null` 处理。
        params: Value,
    },
    /// 不构成合法 CDP 帧的载荷（非 JSON、非对象、缺关键字段）。
    Invalid {
        /// 稳定原因，便于归因与测试断言。
        reason: FrameInvalidReason,
    },
}

/// `Invalid` 的具体原因（闭集，便于测试逐条钉住）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameInvalidReason {
    /// 不是合法 JSON。
    NotJson,
    /// 是 JSON 但不是对象（如裸数组、字符串、数字）。
    NotObject,
    /// 有 `id` 但既无 `result` 也无 `error`——无法判定是成功还是失败。
    ResponseWithoutPayload,
    /// 无 `id` 且无 `method`——既不可能是响应也不可能是事件。
    NeitherResponseNorEvent,
    /// `id` 不是非负整数。
    MalformedId,
    /// `error` 存在但不是合法错误对象（缺 `code`/`message`）。
    MalformedError,
    /// 无 `id` 但有 `method` 却 method 为空串。
    EmptyMethod,
}

impl FrameInvalidReason {
    /// 稳定字符串码，供日志与跨语言归因使用。
    pub fn code(self) -> &'static str {
        match self {
            Self::NotJson => "not_json",
            Self::NotObject => "not_object",
            Self::ResponseWithoutPayload => "response_without_payload",
            Self::NeitherResponseNorEvent => "neither_response_nor_event",
            Self::MalformedId => "malformed_id",
            Self::MalformedError => "malformed_error",
            Self::EmptyMethod => "empty_method",
        }
    }
}

/// 编解码错误。
#[derive(Debug, Clone, PartialEq)]
pub enum FrameError {
    /// 命令的 method 为空。
    EmptyMethod,
    /// 命令指定了会话，但会话 id 是空串（或全空白）。
    EmptySessionId,
    /// 序列化失败（理论上不会发生，保留以便不 panic）。
    Encode(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyMethod => write!(f, "CDP 命令的 method 不得为空"),
            Self::EmptySessionId => write!(f, "CDP 命令的 sessionId 不得为空"),
            Self::Encode(detail) => write!(f, "CDP 命令序列化失败：{detail}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// 解析一条入站文本帧。
///
/// **判定顺序即设计**：
/// 1. 先判 JSON（非 JSON 一律 `NotJson`）；
/// 2. 再判是不是对象（`NotObject`）；
/// 3. 然后**只看 `id` 在不在**——这是区分响应与事件的唯一判据：
///    - 有 `id`：必须是响应。既有 `result` 又有 `error` 时**判 `error` 胜**
///      （失败优先：把失败当成功比把成功当失败危险得多）；
///    - 无 `id`：必须是事件，方法名不得为空。
///
/// 不合法的一律 `Invalid` 并给出稳定原因，**绝不静默丢弃**。
pub fn parse_inbound(raw: &str) -> InboundFrame {
    let value: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            return InboundFrame::Invalid {
                reason: FrameInvalidReason::NotJson,
            }
        }
    };
    let object = match value.as_object() {
        Some(object) => object,
        None => {
            return InboundFrame::Invalid {
                reason: FrameInvalidReason::NotObject,
            }
        }
    };

    // 唯一的响应/事件判据：`id` 字段存在与否。
    let id_present = object.contains_key("id");
    if !id_present {
        return parse_event(object);
    }

    let id = match object.get("id").and_then(Value::as_u64) {
        Some(raw_id) => CommandId(raw_id),
        None => {
            return InboundFrame::Invalid {
                reason: FrameInvalidReason::MalformedId,
            }
        }
    };

    // 失败优先：`error` 与 `result` 同时存在时判失败。
    if let Some(error) = object.get("error") {
        return parse_error(id, error);
    }

    match object.get("result") {
        // 成功但无 `result` 字段：CDP 里合法（方法无返回值），按 null 处理。
        None => InboundFrame::Response {
            id,
            result: Value::Null,
        },
        Some(result) => InboundFrame::Response {
            id,
            result: result.clone(),
        },
    }
}

/// 解析事件分支（已确认无 `id`）。
fn parse_event(object: &Map<String, Value>) -> InboundFrame {
    let method = match object.get("method").and_then(Value::as_str) {
        Some(method) if !method.trim().is_empty() => method.to_string(),
        Some(_) => {
            return InboundFrame::Invalid {
                reason: FrameInvalidReason::EmptyMethod,
            }
        }
        None => {
            return InboundFrame::Invalid {
                reason: FrameInvalidReason::NeitherResponseNorEvent,
            }
        }
    };
    InboundFrame::Event {
        method,
        params: object.get("params").cloned().unwrap_or(Value::Null),
    }
}

/// 解析错误分支。缺 `code` 或 `message` 时判 `MalformedError` 而非编造默认值——
/// 编造默认值会让一个"协议不符"的端点看起来只是"偶发失败"。
fn parse_error(id: CommandId, error: &Value) -> InboundFrame {
    let Some(object) = error.as_object() else {
        return InboundFrame::Invalid {
            reason: FrameInvalidReason::MalformedError,
        };
    };
    let Some(code) = object.get("code").and_then(Value::as_i64) else {
        return InboundFrame::Invalid {
            reason: FrameInvalidReason::MalformedError,
        };
    };
    let Some(message) = object.get("message").and_then(Value::as_str) else {
        return InboundFrame::Invalid {
            reason: FrameInvalidReason::MalformedError,
        };
    };
    InboundFrame::Failure {
        id,
        code,
        message: message.to_string(),
    }
}

/// 从入站帧里取出它对应的命令 id（仅响应/失败帧有）。
pub fn frame_command_id(frame: &InboundFrame) -> Option<CommandId> {
    match frame {
        InboundFrame::Response { id, .. } | InboundFrame::Failure { id, .. } => Some(*id),
        _ => None,
    }
}

/// 一个命令的结果（应答）。
#[derive(Debug, Clone, PartialEq)]
pub enum CommandOutcome {
    /// 成功，带结果载荷。
    Ok(Value),
    /// 失败，带 CDP 错误码与原因。
    Err { code: i64, message: String },
}

/// 把一条响应帧匹配到「它是哪个命令的结果」。
///
/// 送入的帧若既不是响应也不是失败，返回 `None`——调用方据此把事件走另一条路。
/// 本函数**不做超时判定**（那需要时钟，属于调用方），只做纯匹配。
pub fn outcome_for(frame: &InboundFrame) -> Option<(CommandId, CommandOutcome)> {
    match frame {
        InboundFrame::Response { id, result } => Some((*id, CommandOutcome::Ok(result.clone()))),
        InboundFrame::Failure { id, code, message } => Some((
            *id,
            CommandOutcome::Err {
                code: *code,
                message: message.clone(),
            },
        )),
        _ => None,
    }
}

/// 解析一条入站帧并**要求它必须是某个命令的响应**。
///
/// 这是 tokio 层最常用的入口：收到一帧，若它配不上任何在途命令就说明要么是事件
/// （正常，继续读下一帧）要么是坏帧（异常，应当上抛）。返回 `Err` 携带原因，
/// 由调用方决定"继续读"还是"断开"。
pub fn expect_response(raw: &str) -> Result<(CommandId, CommandOutcome), InboundFrame> {
    let frame = parse_inbound(raw);
    match outcome_for(&frame) {
        Some(pair) => Ok(pair),
        None => Err(frame),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 命令编码省略空参数() {
        let frame = CommandFrame::new(CommandId(1), "Page.enable", None);
        assert_eq!(
            frame.encode().unwrap(),
            r#"{"id":1,"method":"Page.enable"}"#
        );
    }

    #[test]
    fn 命令编码带参数() {
        let frame = CommandFrame::new(
            CommandId(7),
            "Page.navigate",
            Some(json!({ "url": "https://example.com" })),
        );
        let encoded = frame.encode().unwrap();
        let parsed: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed["id"], json!(7));
        assert_eq!(parsed["method"], json!("Page.navigate"));
        assert_eq!(parsed["params"]["url"], json!("https://example.com"));
    }

    #[test]
    fn 空方法名被拒绝() {
        let frame = CommandFrame::new(CommandId(1), "   ", None);
        assert_eq!(frame.encode(), Err(FrameError::EmptyMethod));
    }

    #[test]
    fn 带会话的命令把sessionId放在顶层() {
        // 扁平会话模型的硬要求。放在 `params` 里对端不会当路由信息看，
        // 命令会落到浏览器级会话上——这是"静默走偏"而不是报错，所以必须钉死。
        let frame = CommandFrame::with_session(
            CommandId(1),
            "Runtime.evaluate",
            Some(json!({ "expression": "1+1" })),
            "SESSION-1",
        );
        let encoded = frame.encode().unwrap();
        let parsed: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed["sessionId"], json!("SESSION-1"));
        assert_eq!(parsed["method"], json!("Runtime.evaluate"));
        assert_eq!(parsed["params"]["expression"], json!("1+1"));
        // 反向断言：`params` 里**不得**出现 sessionId。
        // 只断言顶层存在的话，一份"两处都写"的实现也能通过。
        assert!(
            parsed["params"].get("sessionId").is_none(),
            "sessionId 不得出现在 params 内，实际：{}",
            parsed["params"]
        );
    }

    #[test]
    fn 带会话且无参数时仍只发顶层sessionId() {
        let frame = CommandFrame::with_session(CommandId(2), "Page.enable", None, "S-9");
        let encoded = frame.encode().unwrap();
        let parsed: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(parsed["sessionId"], json!("S-9"));
        // 无参数时应省略 `params`，而不是发一个只有 sessionId 的 params 对象。
        assert!(parsed.get("params").is_none(), "无参数时不应出现 params");
    }

    #[test]
    fn 无会话的命令不带sessionId字段() {
        let frame = CommandFrame::new(CommandId(3), "Target.getTargets", None);
        let parsed: Value = serde_json::from_str(&frame.encode().unwrap()).unwrap();
        assert!(parsed.get("sessionId").is_none());
    }

    #[test]
    fn 空会话id被拒绝() {
        let frame = CommandFrame::with_session(CommandId(1), "Page.enable", None, "   ");
        assert_eq!(frame.encode(), Err(FrameError::EmptySessionId));
    }

    #[test]
    fn id_分配器从1开始且跳过0() {
        let mut allocator = CommandIdAllocator::new();
        assert_eq!(allocator.allocate(), CommandId(1));
        assert_eq!(allocator.allocate(), CommandId(2));
    }

    #[test]
    fn id_回绕不到0() {
        let mut allocator = CommandIdAllocator { next: u64::MAX };
        assert_eq!(allocator.allocate(), CommandId(u64::MAX));
        assert_eq!(allocator.allocate(), CommandId(1));
    }

    #[test]
    fn 成功响应被识别() {
        let frame = parse_inbound(r#"{"id":3,"result":{"frameId":"A"}}"#);
        assert_eq!(
            frame,
            InboundFrame::Response {
                id: CommandId(3),
                result: json!({ "frameId": "A" })
            }
        );
    }

    #[test]
    fn 无result字段的成功响应按null处理() {
        let frame = parse_inbound(r#"{"id":3}"#);
        assert_eq!(
            frame,
            InboundFrame::Response {
                id: CommandId(3),
                result: Value::Null
            }
        );
    }

    #[test]
    fn 失败响应保留错误码与原因() {
        let frame = parse_inbound(r#"{"id":9,"error":{"code":-32000,"message":"Target closed"}}"#);
        assert_eq!(
            frame,
            InboundFrame::Failure {
                id: CommandId(9),
                code: -32000,
                message: "Target closed".to_string()
            }
        );
    }

    #[test]
    fn 事件被识别且不带id() {
        let frame = parse_inbound(r#"{"method":"Page.loadEventFired","params":{"timestamp":1}}"#);
        assert_eq!(
            frame,
            InboundFrame::Event {
                method: "Page.loadEventFired".to_string(),
                params: json!({ "timestamp": 1 })
            }
        );
    }

    #[test]
    fn 事件即使带result参数字段也不被误判为响应() {
        // 这是本模块存在的核心理由：`id` 在不在是唯一判据。
        let frame =
            parse_inbound(r#"{"method":"Custom.event","params":{"result":"not-a-response"}}"#);
        match frame {
            InboundFrame::Event { method, .. } => assert_eq!(method, "Custom.event"),
            other => panic!("应当判为事件，实际：{other:?}"),
        }
    }

    #[test]
    fn 顶层带result但无id的帧仍是事件() {
        // 这条是「守卫有没有牙齿」的关键输入：`params` 里嵌 result 区分不了
        // 「看 id」与「看 result」两种实现，**顶层** result 才能区分。
        // 缺了它，把判据写成 `contains_key("result")` 也能全绿。
        let frame = parse_inbound(r#"{"method":"Custom.event","result":{"nested":true}}"#);
        match frame {
            InboundFrame::Event { method, .. } => assert_eq!(method, "Custom.event"),
            other => panic!("无 id 即为事件，实际：{other:?}"),
        }
    }

    #[test]
    fn 顶层带error但无id的帧仍是事件() {
        // 同上，`error` 侧的对偶输入。
        let frame = parse_inbound(r#"{"method":"Custom.event","error":{"code":-1,"message":"e"}}"#);
        match frame {
            InboundFrame::Event { method, .. } => assert_eq!(method, "Custom.event"),
            other => panic!("无 id 即为事件，实际：{other:?}"),
        }
    }

    #[test]
    fn 错误与结果同时存在时判失败优先() {
        let frame =
            parse_inbound(r#"{"id":4,"result":{"value":1},"error":{"code":-1,"message":"boom"}}"#);
        match frame {
            InboundFrame::Failure { id, code, .. } => {
                assert_eq!(id, CommandId(4));
                assert_eq!(code, -1);
            }
            other => panic!("错误优先，实际：{other:?}"),
        }
    }

    #[test]
    fn 非json判invalid() {
        assert_eq!(
            parse_inbound("not json at all"),
            InboundFrame::Invalid {
                reason: FrameInvalidReason::NotJson
            }
        );
    }

    #[test]
    fn 裸数组判not_object() {
        assert_eq!(
            parse_inbound("[1,2,3]"),
            InboundFrame::Invalid {
                reason: FrameInvalidReason::NotObject
            }
        );
    }

    #[test]
    fn 既无id又无method判invalid() {
        assert_eq!(
            parse_inbound(r#"{"foo":"bar"}"#),
            InboundFrame::Invalid {
                reason: FrameInvalidReason::NeitherResponseNorEvent
            }
        );
    }

    #[test]
    fn id_非整数判malformed_id() {
        assert_eq!(
            parse_inbound(r#"{"id":"abc","result":null}"#),
            InboundFrame::Invalid {
                reason: FrameInvalidReason::MalformedId
            }
        );
    }

    #[test]
    fn 错误对象缺code判malformed_error() {
        assert_eq!(
            parse_inbound(r#"{"id":1,"error":{"message":"no code"}}"#),
            InboundFrame::Invalid {
                reason: FrameInvalidReason::MalformedError
            }
        );
    }

    #[test]
    fn 空事件方法名判invalid() {
        assert_eq!(
            parse_inbound(r#"{"method":"   "}"#),
            InboundFrame::Invalid {
                reason: FrameInvalidReason::EmptyMethod
            }
        );
    }

    #[test]
    fn 坏帧的稳定码可被断言() {
        assert_eq!(FrameInvalidReason::NotJson.code(), "not_json");
        assert_eq!(FrameInvalidReason::MalformedError.code(), "malformed_error");
    }

    #[test]
    fn expect_response_对事件返回其本身() {
        let result = expect_response(r#"{"method":"Page.loadEventFired"}"#);
        match result {
            Err(InboundFrame::Event { method, .. }) => assert_eq!(method, "Page.loadEventFired"),
            other => panic!("事件应原样返回，实际：{other:?}"),
        }
    }

    #[test]
    fn expect_response_对成功响应返回配对() {
        match expect_response(r#"{"id":2,"result":{"ok":true}}"#) {
            Ok((id, CommandOutcome::Ok(value))) => {
                assert_eq!(id, CommandId(2));
                assert_eq!(value["ok"], json!(true));
            }
            other => panic!("应配对成功，实际：{other:?}"),
        }
    }

    #[test]
    fn expect_response_对失败响应返回配对错误() {
        match expect_response(r#"{"id":5,"error":{"code":-32601,"message":"no such method"}}"#) {
            Ok((id, CommandOutcome::Err { code, message })) => {
                assert_eq!(id, CommandId(5));
                assert_eq!(code, -32601);
                assert_eq!(message, "no such method");
            }
            other => panic!("应配对失败，实际：{other:?}"),
        }
    }

    #[test]
    fn frame_command_id_只对响应有值() {
        assert_eq!(
            frame_command_id(&parse_inbound(r#"{"id":1,"result":null}"#)),
            Some(CommandId(1))
        );
        assert_eq!(
            frame_command_id(&parse_inbound(r#"{"method":"X.y"}"#)),
            None
        );
        assert_eq!(frame_command_id(&parse_inbound("bad")), None);
    }
}
