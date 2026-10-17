//! CDP WebSocket 传输：把 `cdp-client` 的纯判定落到真实 IO。
//!
//! ## 分层动机（为什么传输层几乎不含判定逻辑）
//!
//! `cdp-client` 已经把三类"连得上但结果错"的缺陷（事件当响应、响应当别人的、
//! 连上恶意端点）钉死在纯函数里。传输层的职责**只有**三件：
//!
//! 1. 建连接前，把端点交给 `cdp-client::target::evaluate_debugger_endpoint` 判定
//!    ——**不在这里重写一遍白名单**。重写等于把"哪些端点可信"变成两处事实，
//!    而两处事实必然漂移，漂移的方向通常是无意放宽。
//! 2. 收发：把 `CommandFrame` 编码后发出去，把收到的文本帧交给
//!    `session::CdpCommandSession::handle_frame` 处置。
//! 3. 把处置结论（`RoutingVerdict`）如实上抛给调用方——**包括孤儿响应**。
//!
//! 传输层**不做**的：不判超时（`session` 用调用方给的 `now_ms`）、不解释 CDP 方法
//! 语义（那是 `tool_map` 的事）、不重试（重试会改变"命令是否已发出"的事实，
//! 必须由上层决定）。
//!
//! ## 连接纪律
//!
//! - **只允许 loopback**：白名单复用 `cdp-client`，因此 `localhost.evil.com`
//!   一类前缀欺骗无法通过。
//! - **明文 ws 且无凭据**：端点判定已禁止 URL 内嵌凭据（`HasCredentials`）。
//! - **不做自动重连**：调试端点可能随时被用户关掉。自动重连会让上层以为会话还在，
//!   于是后续命令发到一个"看似正常"的新连接上，而页面状态早已不同。

use std::time::Duration;

use cdp_client::frame::{CommandFrame, CommandId, CommandOutcome};
use cdp_client::session::{
    AbandonReason, CdpCommandSession, RegisteredCommand, RoutingVerdict, TimeoutSweep,
};
use cdp_client::target::{evaluate_debugger_endpoint, EndpointRejectReason, EndpointVerdict};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

pub mod clock;

pub use clock::MonotonicMillis;

/// 建连接或收发过程中出现的失败（闭集）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// 端点未通过 `cdp-client` 的白名单判定。
    ///
    /// 携带 `EndpointRejectReason` 而不是字符串：调用方需要据此**区分**
    /// "用户填错了地址"（`NotUrl`/`NotWsScheme`）与"有人在探测本机服务"
    /// （`HasCredentials`/`NotLoopbackHost`），两者的处置完全不同。
    EndpointRejected(EndpointRejectReason),
    /// TCP/WebSocket 握手失败，或等待响应期间连接层面的失败。
    ConnectFailed(String),
    /// 发送失败（连接已断）。
    SendFailed(String),
    /// 连接在**使用中**断掉（对端关闭、TCP 重置、写失败）。
    ///
    /// 与 `ConnectFailed` 分开是刻意的：`ConnectFailed` 指"从来没连上"（端口没开、
    /// 握手被拒——排查方向是配置），本变体指"连上过但断了"（浏览器被关、标签页
    /// 崩溃——排查方向是使用过程）。合成一个会让日志里两种完全不同的故障长得一样。
    Disconnected(String),
    /// 收到**二进制**帧。CDP 是纯文本协议，二进制帧说明对端不是 CDP——
    /// 静默忽略会让上层一直等一个永不到来的响应。
    BinaryFrameRejected,
    /// 连接被对端正常关闭（`Close` 帧）。
    Closed,
    /// 等待响应期间该命令超时（由 `session` 的判定产出，不是这里另算的）。
    CommandTimedOut { method: String, overdue_ms: u64 },
}

impl TransportError {
    /// 稳定字符串码，供跨层归因。
    pub fn code(&self) -> String {
        match self {
            Self::EndpointRejected(reason) => {
                format!("transport_endpoint_rejected:{}", reason.code())
            }
            Self::ConnectFailed(_) => "transport_connect_failed".to_string(),
            Self::Disconnected(_) => "transport_disconnected".to_string(),
            Self::SendFailed(_) => "transport_send_failed".to_string(),
            Self::BinaryFrameRejected => "transport_binary_frame_rejected".to_string(),
            Self::Closed => "transport_closed".to_string(),
            Self::CommandTimedOut { .. } => AbandonReason::TimedOut.code().to_string(),
        }
    }

    /// 人类可读原因。
    pub fn detail(&self) -> String {
        match self {
            Self::EndpointRejected(reason) => format!("调试端点被拒绝：{}", reason.code()),
            Self::ConnectFailed(detail) => format!("连接调试端点失败：{detail}"),
            Self::Disconnected(detail) => format!("与调试端点的连接已断开：{detail}"),
            Self::SendFailed(detail) => format!("发送 CDP 命令失败：{detail}"),
            Self::BinaryFrameRejected => "调试端点发来了二进制帧；CDP 是文本协议".to_string(),
            Self::Closed => "调试端点已关闭连接".to_string(),
            Self::CommandTimedOut { method, overdue_ms } => {
                format!("CDP 命令 {method} 超时 {overdue_ms}ms")
            }
        }
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail())
    }
}

impl std::error::Error for TransportError {}

/// 建连参数。
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// 调试端点的 websocket 地址（来自 `/json/version` 或 `/json/list`）。
    ///
    /// **不做规范化**：交给 `evaluate_debugger_endpoint` 原样判定。规范化会掩盖
    /// 调用方给错东西的事实。
    pub websocket_url: String,
    /// 单条命令的默认超时（毫秒）。
    pub default_timeout_ms: u64,
    /// 握手（TCP + WebSocket upgrade）超时（毫秒）。
    pub handshake_timeout_ms: u64,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        // 15s 是 CDP 调试端点的常见可用上限：更短会在浏览器刚启动时误判失败，
        // 更长则让"端口没开"这类明显错误要等很久才报。
        Self {
            websocket_url: String::new(),
            default_timeout_ms: 30_000,
            handshake_timeout_ms: 15_000,
        }
    }
}

/// 一个入站帧处置后的结果，含**应上抛的**结论。
#[derive(Debug, Clone, PartialEq)]
pub struct ReceivedFrame {
    /// 处置结论（配对成功 / 孤儿 / 事件 / 坏帧）。
    pub verdict: RoutingVerdict,
    /// 是否应当让上层**立即中断**（协议不符的强信号）。
    ///
    /// 目前只有一种情形触发：孤儿响应。理由是——一条合法的 CDP 端点上，
    /// 我们发出的每条命令都登记过，因此任何无人认领的 `id` 都说明
    /// "这条连接上有别的东西在说话"或"协议不符"。继续使用这条连接
    /// 等于在一份不可信的响应流上继续做判断。
    pub should_abort: bool,
}

impl ReceivedFrame {
    fn new(verdict: RoutingVerdict) -> Self {
        let should_abort = matches!(verdict, RoutingVerdict::Orphaned { .. });
        Self {
            verdict,
            should_abort,
        }
    }
}

/// 一条已建立的 CDP 连接。
///
/// 刻意**不实现** `Clone`：一条连接对应一个 `session` 的在途表，复制连接会让两条
/// 流共享一个在途表，响应路由随之失去意义。
pub struct CdpConnection {
    socket: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    session: CdpCommandSession,
    clock: MonotonicMillis,
    /// 下一个要分配的命令 id。
    ///
    /// **单调递增，永不重用**——这是 `session` 的放弃窗口纪律的前提条件。若这里
    /// 改成"复用最小的空闲 id"，就会反复撞上 `IdInAbandonedWindow`，把纪律变成噪音。
    next_command_id: u64,
    /// 当前页面的目标会话 id（`Target.attachToTarget` 的产物）。为 `None` 时命令走
    /// 浏览器主连接（仅 `Target.*` / `Browser.*` 一类方法有效）。
    session_id: Option<String>,
}

impl std::fmt::Debug for CdpConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CdpConnection")
            .field("pending", &self.session.pending_count())
            .field("next_command_id", &self.next_command_id)
            .finish_non_exhaustive()
    }
}

impl CdpConnection {
    /// 建立连接。
    ///
    /// 端点判定**先于**任何 IO：一个被拒绝的端点不会产生一次 TCP 连接尝试
    /// （否则"禁止连到非本机地址"就变成一句空话——连接已经发出去了）。
    pub async fn connect(options: ConnectOptions) -> Result<Self, TransportError> {
        let url = match evaluate_debugger_endpoint(&options.websocket_url) {
            EndpointVerdict::Allowed => options.websocket_url,
            EndpointVerdict::Rejected(reason) => {
                return Err(TransportError::EndpointRejected(reason))
            }
        };
        let session = CdpCommandSession::new(options.default_timeout_ms)
            .map_err(|_| TransportError::ConnectFailed("默认超时必须大于 0".to_string()))?;
        let handshake = tokio::time::timeout(
            Duration::from_millis(options.handshake_timeout_ms),
            tokio_tungstenite::connect_async(&url),
        )
        .await
        .map_err(|_| TransportError::ConnectFailed("握手超时".to_string()))?
        .map_err(|error| TransportError::ConnectFailed(error.to_string()))?;
        Ok(Self {
            socket: handshake.0,
            session,
            clock: MonotonicMillis::new(),
            // 1 起步、0 保留——与 `cdp_client::frame::CommandIdAllocator` 的纪律一致。
            next_command_id: 1,
            session_id: None,
        })
    }

    /// 已配对的目标会话 id（`Target.attachToTarget` 之后才有）。
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// 设定当前目标会话 id。设为 `None` 表示回到浏览器主连接。
    pub fn set_session_id(&mut self, session_id: Option<String>) {
        self.session_id = session_id;
    }

    /// 在途命令条数。
    pub fn pending_count(&self) -> usize {
        self.session.pending_count()
    }

    /// 只读访问状态机（供上层查事件缓冲、放弃历史）。
    pub fn session(&self) -> &CdpCommandSession {
        &self.session
    }

    /// 可变访问状态机。
    ///
    /// 暴露可变访问是刻意的：上层需要在**不发送命令**的情况下做状态操作
    /// （如连接重建后 `clear_abandoned`）。把它藏在"只能通过命令操作"后面，
    /// 会逼上层去发一条空命令来达到目的。
    pub fn session_mut(&mut self) -> &mut CdpCommandSession {
        &mut self.session
    }

    /// 分配下一个命令 id（单调递增）。
    fn allocate_command_id(&mut self) -> CommandId {
        let id = CommandId(self.next_command_id);
        self.next_command_id = if self.next_command_id == u64::MAX {
            1
        } else {
            self.next_command_id + 1
        };
        id
    }

    /// 发出一条命令并**只做发送**（不等待响应）。
    ///
    /// 分为"发送"与"接收"两步而不是"发一条等一条"，是因为 CDP 允许同一连接上
    /// 有多个在途命令、响应可以乱序返回。发一条等一条会把并发能力白白丢掉，
    /// 并且在收到**事件**时会陷入"这不是我要的响应，那是什么"的尴尬。
    ///
    /// 返回分配到的命令 id 与截止时刻。
    ///
    /// ## 登记撤回有三处，只有两处能被测试确定性地触达
    ///
    /// 命令是**先登记再发送**的（顺序反过来会在发送失败时留下泄漏）。因此三处
    /// 失败都必须撤回登记：编码失败、写入失败、以及写入成功但连接随后断开
    /// （由等待路径撤回）。
    ///
    /// 其中「写入失败」这一分支在本环境下**无法被集成测试确定性地触达**：对端消失后，
    /// 内核仍会接受写入并把它缓冲（TCP 语义允许），真正的失败在**下一次读**时才浮现，
    /// 于是它落进 `receive_one` 的断开分支——那条路径由
    /// `连接已断时发送失败且不留下在途命令` 与 `连接关闭时等待返回关闭错误` 覆盖。
    ///
    /// 保留这个分支的理由是**防御性**而不是"它有测试"：`send` 在连接已被标记关闭、
    /// 或底层驱动直接报错时会立刻失败，此时若不撤回就会留下一条永远不会被响应的
    /// 命令。把它写在这里并标注清楚，好过让它看起来像"已被测试证明"。
    pub async fn send(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
        timeout_ms: Option<u64>,
    ) -> Result<RegisteredCommand, TransportError> {
        let now = self.clock.now_ms();
        let id = self.allocate_command_id();
        // 命令 id 由会话状态机登记——**先登记再发送**。顺序反过来的话，如果发送失败，
        // 在途表里就会留下一条永远不会被响应的命令（泄漏），而调用方拿到的错误
        // 又暗示"没发出去"。
        let registered = self
            .session
            .register(id, method, now, timeout_ms)
            .map_err(|error| TransportError::SendFailed(error.code().to_string()))?;
        let encoded = match self.encode_command(registered.id, method, params) {
            Ok(encoded) => encoded,
            Err(error) => {
                // 编码失败：撤回刚登记的命令，避免在途表泄漏。
                let _ = self
                    .session
                    .abandon(registered.id, AbandonReason::Cancelled);
                return Err(error);
            }
        };
        if let Err(error) = self.socket.send(Message::Text(encoded.into())).await {
            // 发送失败：把刚登记的命令撤回，避免在途表泄漏——否则那条命令会永远
            // 留在表里，且此后针对该 id 的任何响应都会被当成"迟到响应"。
            let _ = self
                .session
                .abandon(registered.id, AbandonReason::Cancelled);
            // 写入失败说明连接已不可用（对端关闭 / TCP 重置），归为 `Disconnected`
            // 而不是 `SendFailed`：后者的排查方向是"参数或负载有问题"，
            // 而这里的根因是连接本身没了。
            return Err(TransportError::Disconnected(error.to_string()));
        }
        Ok(registered)
    }

    /// 把方法名与参数编成一行 JSON；有目标会话时把 `sessionId` 放在**顶层**。
    ///
    /// ## 为什么 `sessionId` 不能并入 `params`
    ///
    /// CDP 的扁平会话模型要求目标会话由与 `id`、`method` **并列**的顶层 `sessionId`
    /// 表达。曾经这里把 sessionId 插进 `params`，后果不是报错而是**静默走偏**：对端
    /// 不认这个位置，于是把命令当作浏览器级命令执行——`Runtime.evaluate` 会在浏览器级
    /// 上下文求值，而不是在那个已 attach 的页面里。
    ///
    /// 原先的传输测试恰好断言了 `params.sessionId`，把错误格式固定成了通过条件；
    /// 现在的测试断言顶层字段**并反向断言 `params` 内不得出现 sessionId**。
    fn encode_command(
        &self,
        id: CommandId,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<String, TransportError> {
        // 参数一旦出现必须是 JSON 对象：CDP 的 `params` 就是对象，数组/标量属于
        // 上层构造错误。拒绝而不是发出去——对端可能接受一条语义不明的命令并做出
        // 意外动作。
        if let Some(value) = params.as_ref() {
            if !value.is_object() {
                return Err(TransportError::SendFailed(
                    "CDP 命令的参数必须是 JSON 对象".to_string(),
                ));
            }
        }
        let frame = match self.session_id.as_deref() {
            Some(session_id) => CommandFrame::with_session(id, method, params, session_id),
            None => CommandFrame::new(id, method, params),
        };
        frame
            .encode()
            .map_err(|error| TransportError::SendFailed(error.to_string()))
    }

    /// 接收并处置**一条**入站帧。返回 `None` 表示连接被正常关闭。
    ///
    /// 调用方拿到 `ReceivedFrame` 后应检查 `should_abort`；为真时应当放弃这条连接
    /// （见 `ReceivedFrame::should_abort` 的说明）。
    pub async fn receive_one(&mut self) -> Result<Option<ReceivedFrame>, TransportError> {
        loop {
            let message = match self.socket.next().await {
                None => return Ok(None),
                Some(Ok(message)) => message,
                // 读失败 = 连接在使用中断掉，不是"从来没连上"。
                Some(Err(error)) => return Err(TransportError::Disconnected(error.to_string())),
            };
            match message {
                Message::Text(text) => {
                    let now = self.clock.now_ms();
                    let frame = cdp_client::frame::parse_inbound(&text);
                    let verdict = self.session.handle_frame(frame, now);
                    return Ok(Some(ReceivedFrame::new(verdict)));
                }
                // tungstenite 内部处理 Ping/Pong 的应答，走到这里说明是对端主动发的。
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Binary(_) => return Err(TransportError::BinaryFrameRejected),
                Message::Close(_) => return Ok(None),
                Message::Frame(_) => continue,
            }
        }
    }

    /// 接收直到某条命令的响应到达，返回它的结论。
    ///
    /// 途中的事件被正常记入缓冲（不丢弃），孤儿响应与坏帧则**立即上抛错误**——
    /// 在一条命令的等待路径上看到它们，说明协议已不可信，继续等待没有意义。
    ///
    /// ## 超时为什么不能只在循环开头检查
    ///
    /// 本方法最初写成"每轮循环开头调一次 `sweep_timeouts`，然后 `receive_one().await`"。
    /// 那个写法**在超时最需要起作用的场景下失效**：对端什么都不发时，代码会一直停在
    /// `receive_one()` 里，永远回不到循环开头去查时钟——超时判定在"没有任何帧到达"
    /// 时是结构性不可达的。而"没有任何帧到达"恰恰是超时要处理的那一种情况。
    ///
    /// 正确做法是把**等待下一帧**与**等待截止时刻**放在一次 `select!` 里竞争：
    /// 哪一个先到就处理哪一个。截止时刻由本连接自己的单调时钟给出，
    /// 因此超时的定义仍与单测里钉死的 `session` 判定完全一致（不另算一套）。
    pub async fn await_response(
        &mut self,
        id: CommandId,
    ) -> Result<CommandOutcome, TransportError> {
        loop {
            // 先处理"已经到点"的情况：上一轮可能在收到其他命令的响应后才回头。
            if let Some(error) = self.take_expired(id) {
                return Err(error);
            }
            // 该命令自己的截止时刻（登记时写入），用来和"下一帧"竞争。
            let Some(remaining) = self.remaining_ms(id) else {
                // 不在途：要么已被超时清扫（上面会返回 Err），要么被别处放弃。
                return Err(TransportError::CommandTimedOut {
                    method: "<unknown>".to_string(),
                    overdue_ms: 0,
                });
            };
            let received = tokio::select! {
                biased;
                // 时间先到期 → 判超时。`biased` 保证同刻到达时以超时为准，
                // 与 `session` 的"到点即超时"（<=）一致。
                _ = tokio::time::sleep(Duration::from_millis(remaining)) => {
                    return Err(self.take_expired(id).unwrap_or_else(|| {
                        TransportError::CommandTimedOut {
                            method: "<unknown>".to_string(),
                            overdue_ms: 0,
                        }
                    }));
                }
                frame = self.receive_one() => frame,
            };
            let received = match received {
                Ok(Some(received)) => received,
                // 对端正常关闭：撤回登记。
                Ok(None) => {
                    let _ = self.session.abandon(id, AbandonReason::Cancelled);
                    return Err(TransportError::Closed);
                }
                // 读失败（连接断开）：同样撤回登记。**不能**用 `?` 直接上抛——
                // 那会跳过撤回，把一条永远不会被响应的命令留在在途表里。
                Err(error) => {
                    let _ = self.session.abandon(id, AbandonReason::Cancelled);
                    return Err(error);
                }
            };
            match received.verdict {
                // 目标命令的响应：返回。
                RoutingVerdict::Routed {
                    id: routed_id,
                    outcome,
                    ..
                } if routed_id == id => return Ok(outcome),
                // 事件：已在 `handle_frame` 里入缓冲，继续等。
                RoutingVerdict::IgnoredEvent { .. } => continue,
                // 其他在途命令的响应（并发乱序）：继续等。
                RoutingVerdict::Routed { .. } => continue,
                // 坏帧：上抛，不静默继续。
                RoutingVerdict::Rejected { reason } => {
                    return Err(TransportError::ConnectFailed(format!(
                        "调试端点发来无法解析的帧：{}",
                        reason.code()
                    )))
                }
                // 孤儿响应：协议不可信的强信号，上抛。
                RoutingVerdict::Orphaned { reason, .. } => {
                    return Err(TransportError::ConnectFailed(format!(
                        "调试端点发来了无人认领的响应：{}",
                        reason.code()
                    )))
                }
            }
        }
    }

    /// 若某条命令已过截止时刻，清扫它并返回对应的传输层错误。
    ///
    /// 清扫委托给 `session.sweep_timeouts`（它按 id 顺序、幂等、并记入放弃历史），
    /// 本方法只负责把"扫出来的那条是不是我在等的那条"翻译成错误。
    fn take_expired(&mut self, waited: CommandId) -> Option<TransportError> {
        match self.session.sweep_timeouts(self.clock.now_ms()) {
            TimeoutSweep::None => None,
            TimeoutSweep::Expired {
                id,
                method,
                overdue_ms,
            } => {
                // 扫出来的可能是**另一条**并发命令。那种情况下它的等待者会自己
                // 收到这个错误；本调用者继续等自己的那条（它还没到点）。
                if id == waited {
                    Some(TransportError::CommandTimedOut { method, overdue_ms })
                } else {
                    None
                }
            }
        }
    }

    /// 某条在途命令距截止时刻还剩多少毫秒（已过点则返回 `Some(0)`）。
    /// 不在途返回 `None`。
    fn remaining_ms(&self, id: CommandId) -> Option<u64> {
        let deadline = self.session.deadline_ms(id)?;
        Some(deadline.saturating_sub(self.clock.now_ms()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cdp_client::session::AbandonReason;

    fn options(url: &str) -> ConnectOptions {
        ConnectOptions {
            websocket_url: url.to_string(),
            ..ConnectOptions::default()
        }
    }

    /// 被拒绝的端点必须**在任何 IO 之前**失败——本测试在无网络环境下跑得飞快，
    /// 本身就是证据：没有发生任何连接尝试。
    #[tokio::test]
    async fn 非本机端点在建连前被拒绝() {
        let error =
            CdpConnection::connect(options("ws://evil.example.com:9222/devtools/browser/x"))
                .await
                .unwrap_err();
        assert_eq!(
            error,
            TransportError::EndpointRejected(EndpointRejectReason::NotLoopbackHost)
        );
        // 前缀不是硬编码的：它必须真的是 `cdp-client` 给的那条码。
        // 硬编码会让"传输层自己编了一套码"这种漂移无法被发现。
        assert_eq!(
            error.code(),
            format!(
                "transport_endpoint_rejected:{}",
                EndpointRejectReason::NotLoopbackHost.code()
            )
        );
    }

    #[tokio::test]
    async fn 本机前缀欺骗端点被拒绝() {
        // `localhost.evil.com` 前缀是 `localhost`，后缀是 `evil.com`——白名单是
        // 精确匹配，因此两者都拒。本测试钉住"绝不退化成前缀/后缀匹配"。
        for hostile in [
            "ws://localhost.evil.com:9222/devtools/browser/x",
            "ws://evil-localhost:9222/devtools/browser/x",
            "ws://127.0.0.1.evil.com:9222/devtools/browser/x",
        ] {
            let error = CdpConnection::connect(options(hostile)).await.unwrap_err();
            assert_eq!(
                error,
                TransportError::EndpointRejected(EndpointRejectReason::NotLoopbackHost),
                "敌对端点 {hostile} 应被拒绝"
            );
        }
    }

    #[tokio::test]
    async fn 带凭据的端点被拒绝() {
        let error = CdpConnection::connect(options("ws://user:pass@127.0.0.1:9222/x"))
            .await
            .unwrap_err();
        assert_eq!(
            error,
            TransportError::EndpointRejected(EndpointRejectReason::HasCredentials)
        );
    }

    #[tokio::test]
    async fn 非ws协议端点被拒绝() {
        let error = CdpConnection::connect(options("http://127.0.0.1:9222/json"))
            .await
            .unwrap_err();
        assert_eq!(
            error,
            TransportError::EndpointRejected(EndpointRejectReason::NotWsScheme)
        );
    }

    #[tokio::test]
    async fn 合法本机端点会走到真实连接尝试() {
        // 127.0.0.1:1 是保留端口，几乎必然拒绝连接——本测试关心的是"它**试过了**"，
        // 从而证明判定放行之后的路径是通的。
        let error = CdpConnection::connect(ConnectOptions {
            websocket_url: "ws://127.0.0.1:1/devtools/browser/x".to_string(),
            handshake_timeout_ms: 2_000,
            ..ConnectOptions::default()
        })
        .await
        .unwrap_err();
        assert!(
            matches!(error, TransportError::ConnectFailed(_)),
            "应当是连接失败而不是端点被拒，实际：{error:?}"
        );
    }

    #[test]
    fn 超时错误的稳定码与放弃原因一致() {
        // 传输层不另造一套超时语义：它的超时码与 `session::AbandonReason::TimedOut`
        // 逐字相同，这样上层不必区分"状态机判的超时"与"传输层判的超时"。
        let error = TransportError::CommandTimedOut {
            method: "Page.navigate".to_string(),
            overdue_ms: 120,
        };
        assert_eq!(error.code(), AbandonReason::TimedOut.code());
        assert_eq!(error.code(), "command_timed_out");
        assert!(error.detail().contains("Page.navigate"));
    }

    #[test]
    fn 各类错误的稳定码可被断言() {
        assert_eq!(
            TransportError::BinaryFrameRejected.code(),
            "transport_binary_frame_rejected"
        );
        assert_eq!(TransportError::Closed.code(), "transport_closed");
        assert_eq!(
            TransportError::SendFailed("x".to_string()).code(),
            "transport_send_failed"
        );
        assert_eq!(
            TransportError::Disconnected("x".to_string()).code(),
            "transport_disconnected"
        );
        assert_eq!(
            TransportError::ConnectFailed("x".to_string()).code(),
            "transport_connect_failed"
        );
        // 两者必须是**不同**的码：一个指"没连上"，一个指"连上过但断了"。
        assert_ne!(
            TransportError::Disconnected(String::new()).code(),
            TransportError::ConnectFailed(String::new()).code()
        );
    }

    #[test]
    fn 默认超时窗口与放弃原因一致() {
        let defaults = ConnectOptions::default();
        assert_eq!(defaults.default_timeout_ms, 30_000);
        assert_eq!(defaults.handshake_timeout_ms, 15_000);
    }
}
