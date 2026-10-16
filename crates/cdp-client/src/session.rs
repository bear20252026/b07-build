//! CDP 命令会话状态机：在途命令登记、响应路由、迟到/未知响应处置、事件分类。
//!
//! ## 为什么把它和传输层分开
//!
//! `frame.rs` 只回答"这一条字节是什么"（响应 / 失败 / 事件 / 坏帧）。但浏览器自动
//! 化真正的缺陷出在**下一步**：这条响应**属于谁**、**能不能收**、**收晚了怎么办**。
//!
//! 三类最容易写错、且都不会报错的形态：
//!
//! 1. **把未知 id 的响应当成"我最后发的那条"**。CDP 允许同一条连接上有多个在途
//!    命令，响应可以乱序返回。若实现用"最后一个 id"或"最近一条在途"来配对，那么
//!    两条并发命令会**互相收到对方的结果**——页面 A 的导航结果被当成页面 B 的点击
//!    结果，两边都不报错，Agent 继续在错的页面上跑。
//! 2. **迟到的响应把已经放弃的命令"复活"**。命令超时后调用方已经走了失败路径，
//!    此时真正的响应到达。若状态机还留着一个空槽等着被填，这个结果就会投给
//!    **下一条复用同一 id 的命令**（id 回绕后完全可能）。
//! 3. **把未知 id 的响应静默丢掉**。丢掉意味着"这条命令永远不返回"，调用方一路
//!    等到超时，而真正的原因（协议不符 / 连错了端点 / 别的东西在这条连接上说话）
//!    被掩盖成"偶发超时"。
//!
//! 本模块把这三种形态全部变成**可断言的输出**：每个入站帧都必须落进一个显式分支
//! （`Routed` / `Orphaned` / `IgnoredEvent` / `Rejected`），没有"默认吃掉"这条路。
//!
//! ## 边界
//!
//! 纯数据：**不读时钟**。超时判定需要的时刻由调用方作为参数传入（`now_ms`），
//! 因此整个模块可以用纯数据单测，不需要 tokio、不需要 mock 连接、不需要 sleep。
//! 这是"协议正确性与传输分开"的具体落地：传输层只负责把字节搬进来、把判定结果
//! 搬出去。
//!
//! ## 与 `frame.rs` 的关系
//!
//! `frame.rs` 产出 `InboundFrame`；本模块消费它。两层的错误**不混用**：
//! 帧层的 `FrameInvalidReason` 说明"这串字节不是合法 CDP 帧"，本模块的
//! `RoutingVerdict::Rejected` 说明"这是合法帧，但我不能收它"。分开才能让归因准确。

use std::collections::BTreeMap;

use serde_json::Value;

use crate::frame::{CommandId, CommandOutcome, InboundFrame};

/// 一条在途命令的登记信息。
#[derive(Debug, Clone, PartialEq)]
struct PendingCommand {
    /// 命令方法名（仅用于归因与错误文案——缺陷排查时"哪条命令没回来"是第一个问题）。
    method: String,
    /// 发出时刻（毫秒，由调用方提供；本模块不读时钟）。
    sent_at_ms: u64,
    /// 该命令的截止时刻（毫秒）。
    deadline_ms: u64,
}

/// 一条命令被放弃（超时 / 主动取消）的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbandonReason {
    /// 超过截止时刻仍未收到响应。
    TimedOut,
    /// 调用方主动放弃（如上层任务被取消）。
    Cancelled,
}

impl AbandonReason {
    /// 稳定字符串码，供外部归因。
    pub fn code(self) -> &'static str {
        match self {
            Self::TimedOut => "command_timed_out",
            Self::Cancelled => "command_cancelled",
        }
    }
}

/// 一个入站帧被处置后的结论。
///
/// **互斥且穷尽**：任何入站帧都必然落进其中之一。刻意不提供"什么都不做"的变体，
/// 因为那正是缺陷藏身的地方。
#[derive(Debug, Clone, PartialEq)]
pub enum RoutingVerdict {
    /// 配对成功：这条响应对应那条在途命令，且该命令仍可接收。
    Routed {
        /// 对应的命令 id。
        id: CommandId,
        /// 命令方法名（归因用）。
        method: String,
        /// 结果（成功载荷或 CDP 错误）。
        outcome: CommandOutcome,
        /// 从发出到收到响应的耗时（毫秒）。
        elapsed_ms: u64,
    },
    /// **孤儿响应**：`id` 合法，但没有任何在途命令认领它。
    ///
    /// 这**不是**可以忽略的情况。它要么是①迟到响应（该命令已超时被放弃），要么是
    /// ②协议不符（对端在自己的 id 空间里说话），要么是③id 回绕后的串台。三者都
    /// 必须让上层看见，而不是静默吞掉。
    Orphaned {
        /// 无人认领的命令 id。
        id: CommandId,
        /// 为什么无人认领。
        reason: OrphanReason,
        /// 该帧承载的结果（保留以便上层判断危害）。
        outcome: CommandOutcome,
    },
    /// 事件帧（无 `id`）——正常，记入事件缓冲，不影响在途登记。
    IgnoredEvent {
        /// 事件方法名。
        method: String,
    },
    /// 合法 CDP 帧，但本会话**不能接收**（坏帧，或结构性不可处置）。
    Rejected {
        /// 稳定原因。
        reason: RoutingRejectReason,
    },
}

/// 孤儿响应的具体成因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrphanReason {
    /// 该 id 曾经在途，但已被判定超时/取消并移除——**迟到响应**。
    ///
    /// 与 `NeverSeen` 分开是刻意的：迟到响应说明"连接其实还活着，只是慢"，
    /// 而从未见过说明"这条连接上有别的东西在说话"。两者的处置完全不同。
    ArrivedAfterAbandon,
    /// 从未发出过这个 id 的命令。
    NeverSeen,
}

impl OrphanReason {
    /// 稳定字符串码。
    pub fn code(self) -> &'static str {
        match self {
            Self::ArrivedAfterAbandon => "orphan_arrived_after_abandon",
            Self::NeverSeen => "orphan_never_seen",
        }
    }
}

/// 「合法帧但不能收」的具体原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingRejectReason {
    /// 帧层判定为非法。**带上帧层的具体原因**而不是压成一个常量——
    /// `not_json`（对端不是 CDP）与 `neither_response_nor_event`（报文形状不符）
    /// 指向完全不同的排查方向，压平之后两者都变成"协议错误"，
    /// 排查时唯一的信息来源就没了。
    InvalidFrame(crate::frame::FrameInvalidReason),
}

impl RoutingRejectReason {
    /// 稳定字符串码：直接沿用帧层的码，不再造一层。
    ///
    /// 刻意**不加** `routing_` 前缀——加了会让同一条事实（"这帧是 `not_json`"）
    /// 在两层各有一个码，归因时需要维护一张映射表。
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidFrame(reason) => reason.code(),
        }
    }
}

/// 查询一条在途命令是否已超时的结论。
#[derive(Debug, Clone, PartialEq)]
pub enum TimeoutSweep {
    /// 没有命令超时。
    None,
    /// 有命令超时，已从在途表移除（**幂等**：同一条命令只回报一次）。
    Expired {
        /// 超时命令的 id。
        id: CommandId,
        /// 超时命令的方法名。
        method: String,
        /// 超出截止时刻多久（毫秒）。
        overdue_ms: u64,
    },
}

impl TimeoutSweep {
    /// 是否真的扫出了超时命令。
    pub fn expired(&self) -> bool {
        matches!(self, Self::Expired { .. })
    }
}

/// 会话状态机的稳定错误码（构造期错误）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    /// 超时窗口为 0——一个"立刻超时"的命令没有任何意义，且会让所有响应都变成
    /// 迟到响应。拒绝而不是静默钳到 1。
    ZeroTimeout,
    /// id 已在在途表中——**绝不覆盖**。覆盖会让先发那条命令的响应投给后发那条，
    /// 正是本模块要防的第一类缺陷。
    DuplicateId,
    /// id 在**放弃历史**里——见 `CdpCommandSession::register` 的说明。
    ///
    /// 复用一条已放弃命令的 id 会导致一个**静默串台**：那条命令的响应可能还在
    /// 路上（对端已经写出去了，只是慢），它到达时会命中新登记的命令，于是新命令
    /// 收到的是**上一条命令的结果**。两边都不报错，Agent 继续在错的页面上跑。
    /// 这是本模块要防的第二类缺陷，比 `DuplicateId` 更隐蔽——因为 id 在表里
    /// "看起来是空的"。
    IdInAbandonedWindow,
}

impl SessionError {
    /// 稳定字符串码。
    pub fn code(self) -> &'static str {
        match self {
            Self::ZeroTimeout => "session_zero_timeout",
            Self::DuplicateId => "session_duplicate_id",
            Self::IdInAbandonedWindow => "session_id_in_abandoned_window",
        }
    }
}

/// 一条命令登记成功后的回执。
#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredCommand {
    /// 分配到的命令 id。
    pub id: CommandId,
    /// 该命令的截止时刻（毫秒）。
    pub deadline_ms: u64,
}

/// CDP 命令会话状态机。
///
/// 持有三块状态：
/// - `pending`：在途命令（id → 登记信息）；
/// - `abandoned`：**已放弃**的历史 id（用于把迟到响应与"从未见过"区分开）；
/// - `events`：事件缓冲（有界，见 `EVENT_BUFFER_CAPACITY`）。
#[derive(Debug, Clone)]
pub struct CdpCommandSession {
    pending: BTreeMap<u64, PendingCommand>,
    abandoned: BTreeMap<u64, AbandonReason>,
    events: Vec<SessionEvent>,
    default_timeout_ms: u64,
}

/// 事件缓冲的一条记录。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionEvent {
    /// 事件方法名。
    pub method: String,
    /// 事件参数。
    pub params: Value,
    /// 收到时刻（毫秒，由调用方提供）。
    pub received_at_ms: u64,
}

/// 事件缓冲容量：超出后按**最旧优先**丢弃。
///
/// 有界是必须的：事件是浏览器主动推的，Agent 可能长时间不消费（比如卡在一次
/// `Runtime.evaluate` 上），无界缓冲会把内存吃光。丢最旧而不是丢最新，是因为
/// 页面自动化里"最近发生的事"通常比"很久以前发生的事"更有诊断价值。
pub const EVENT_BUFFER_CAPACITY: usize = 256;

/// 已放弃 id 的保留上限。
///
/// 保留是为了把"迟到响应"与"从未见过的 id"区分开。但保留不能无界——一条长连接
/// 上放弃 id 会持续累积。超出后按最旧的先淘汰：**迟到的判定有时间窗**，一条几十万
/// 条命令之前的 id 再回来，把它当"从未见过"并没有实际损失。
pub const ABANDONED_HISTORY_CAPACITY: usize = 4_096;

impl CdpCommandSession {
    /// 新建一个会话，给定**默认超时窗口**（毫秒）。
    pub fn new(default_timeout_ms: u64) -> Result<Self, SessionError> {
        if default_timeout_ms == 0 {
            return Err(SessionError::ZeroTimeout);
        }
        Ok(Self {
            pending: BTreeMap::new(),
            abandoned: BTreeMap::new(),
            events: Vec::new(),
            default_timeout_ms,
        })
    }

    /// 默认超时窗口（毫秒）。
    pub fn default_timeout_ms(&self) -> u64 {
        self.default_timeout_ms
    }

    /// 登记一条待发出的命令。
    ///
    /// `timeout_ms` 为 `None` 时用会话默认值。
    ///
    /// **两类 id 一律拒绝**：
    /// - 已在在途表中（`DuplicateId`）：覆盖会让先发那条的响应投给后发那条；
    /// - 在**放弃历史**里（`IdInAbandonedWindow`）：那条命令的响应可能仍在路上，
    ///   复用它会让新命令收到旧结果——静默串台。
    ///
    /// 第二条是本模块最容易被忽略的一条纪律：放弃一条命令**不等于**它的响应不会
    /// 再来。对端可能已经写出去了，只是慢。因此放弃是"单方面不等"，不是"取消"。
    /// 要让某个 id 重新可用，调用方必须显式调用 `release_abandoned_id`，且应当
    /// **只在连接已重建**（旧响应不可能再到达）时做。
    pub fn register(
        &mut self,
        id: CommandId,
        method: impl Into<String>,
        now_ms: u64,
        timeout_ms: Option<u64>,
    ) -> Result<RegisteredCommand, SessionError> {
        let timeout = timeout_ms.unwrap_or(self.default_timeout_ms);
        if timeout == 0 {
            return Err(SessionError::ZeroTimeout);
        }
        if self.pending.contains_key(&id.0) {
            return Err(SessionError::DuplicateId);
        }
        if self.abandoned.contains_key(&id.0) {
            return Err(SessionError::IdInAbandonedWindow);
        }
        let deadline_ms = now_ms.saturating_add(timeout);
        self.pending.insert(
            id.0,
            PendingCommand {
                method: method.into(),
                sent_at_ms: now_ms,
                deadline_ms,
            },
        );
        Ok(RegisteredCommand { id, deadline_ms })
    }

    /// 把某个 id 从放弃历史中放出，使其可以重新登记。
    ///
    /// 调用方**必须**确信该 id 的响应永远不会再到达（正常情形：底层连接已重建，
    /// 旧连接的响应随连接一起消失）。放出一个响应可能仍在路上的 id，就是把
    /// 串台缺陷重新引回来。
    ///
    /// 返回该 id 原本的放弃原因；若它本就不在放弃历史里，返回 `None`。
    pub fn release_abandoned_id(&mut self, id: CommandId) -> Option<AbandonReason> {
        self.abandoned.remove(&id.0)
    }

    /// 清空放弃历史（连接重建后调用）。
    ///
    /// 与 `release_abandoned_id` 是同一件事的批量形态，理由相同：**只在旧连接的
    /// 响应不可能再到达时调用**。
    pub fn clear_abandoned(&mut self) -> usize {
        let count = self.abandoned.len();
        self.abandoned.clear();
        count
    }

    /// 放弃历史中的条目数（供测试与诊断）。
    pub fn abandoned_count(&self) -> usize {
        self.abandoned.len()
    }

    /// 正在等待响应的命令条数。
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// 某条命令是否仍在途。
    pub fn is_pending(&self, id: CommandId) -> bool {
        self.pending.contains_key(&id.0)
    }

    /// 某条在途命令的截止时刻（毫秒）。不在途返回 `None`。
    ///
    /// 传输层需要它来把"等到什么时候"交给调度器（`select!` 里的 sleep），
    /// 而不是自己再存一份截止时刻——两处存同一件事必然漂移。
    pub fn deadline_ms(&self, id: CommandId) -> Option<u64> {
        self.pending.get(&id.0).map(|pending| pending.deadline_ms)
    }

    /// 某条在途命令的发出时刻（毫秒）。不在途返回 `None`。
    pub fn sent_at_ms(&self, id: CommandId) -> Option<u64> {
        self.pending.get(&id.0).map(|pending| pending.sent_at_ms)
    }

    /// 处置一条入站帧。
    ///
    /// **判定顺序即设计**：
    /// 1. 坏帧 → `Rejected`（走帧层的原因，不在这里重判）；
    /// 2. 事件 → `IgnoredEvent`（记入缓冲；不影响在途登记）；
    /// 3. 响应 → 查在途表：
    ///    - 命中 → `Routed`（并**从在途表移除**，同一条命令只可能被路由一次）；
    ///    - 未命中 → `Orphaned`（再查放弃历史，区分迟到 / 从未见过）。
    pub fn handle_frame(&mut self, frame: InboundFrame, now_ms: u64) -> RoutingVerdict {
        match frame {
            InboundFrame::Invalid { reason } => RoutingVerdict::Rejected {
                reason: RoutingRejectReason::InvalidFrame(reason),
            },
            InboundFrame::Event { method, params } => {
                self.push_event(SessionEvent {
                    method: method.clone(),
                    params,
                    received_at_ms: now_ms,
                });
                RoutingVerdict::IgnoredEvent { method }
            }
            InboundFrame::Response { id, result } => {
                self.route(id, CommandOutcome::Ok(result), now_ms)
            }
            InboundFrame::Failure { id, code, message } => {
                self.route(id, CommandOutcome::Err { code, message }, now_ms)
            }
        }
    }

    /// 查在途表并把结果交给它，或判为孤儿。
    fn route(&mut self, id: CommandId, outcome: CommandOutcome, now_ms: u64) -> RoutingVerdict {
        // 先取出——**无论成功还是失败都移除**。成功不移除会让一条命令被路由两次
        // （对端重复回包时，第二次会投给下一条复用同 id 的命令）。
        match self.pending.remove(&id.0) {
            Some(pending) => RoutingVerdict::Routed {
                id,
                method: pending.method,
                outcome,
                elapsed_ms: now_ms.saturating_sub(pending.sent_at_ms),
            },
            None => {
                let reason = if self.abandoned.contains_key(&id.0) {
                    OrphanReason::ArrivedAfterAbandon
                } else {
                    OrphanReason::NeverSeen
                };
                RoutingVerdict::Orphaned {
                    id,
                    reason,
                    outcome,
                }
            }
        }
    }

    /// 把一条命令从在途表移除并**记入放弃历史**（供迟到响应归因）。
    ///
    /// 移除是幂等的：对一条不在途的命令再放弃一次，返回 `false` 而不是报错。
    pub fn abandon(&mut self, id: CommandId, reason: AbandonReason) -> bool {
        let removed = self.pending.remove(&id.0).is_some();
        if removed {
            self.abandoned.insert(id.0, reason);
            self.prune_abandoned();
        }
        removed
    }

    /// 扫出**已超过截止时刻**的命令并逐条移除。
    ///
    /// 每次只回报**一条**，是因为调用方通常要在每条超时命令上做一件事（发错误事件、
    /// 清理资源）——把这些动作挤进一个"顺便返回列表"的接口，只会让调用方多写一层
    /// 循环。要一次清空就多调几次直到 `None`。
    ///
    /// **按 id 顺序**而不是"任意一条"：`BTreeMap` 迭代有序，超时回报的顺序因此是
    /// 确定的、可测试的，不会因哈希种子不同而在不同机器上表现不同。
    pub fn sweep_timeouts(&mut self, now_ms: u64) -> TimeoutSweep {
        let expired_id = self
            .pending
            .iter()
            .find(|(_, pending)| pending.deadline_ms <= now_ms)
            .map(|(id, _)| *id);
        let Some(raw_id) = expired_id else {
            return TimeoutSweep::None;
        };
        let Some(pending) = self.pending.remove(&raw_id) else {
            return TimeoutSweep::None;
        };
        self.abandoned.insert(raw_id, AbandonReason::TimedOut);
        self.prune_abandoned();
        TimeoutSweep::Expired {
            id: CommandId(raw_id),
            method: pending.method,
            overdue_ms: now_ms.saturating_sub(pending.deadline_ms),
        }
    }

    /// 把全部在途命令判为超时并清空，返回**放弃数量**。
    pub fn abandon_all(&mut self, reason: AbandonReason) -> usize {
        let ids: Vec<u64> = self.pending.keys().copied().collect();
        for id in &ids {
            self.abandoned.insert(*id, reason);
        }
        self.pending.clear();
        self.prune_abandoned();
        ids.len()
    }

    /// 取事件缓冲（最旧在前）。
    pub fn events(&self) -> &[SessionEvent] {
        &self.events
    }

    /// 取走事件缓冲（保留容量，不清空历史容量分配）。
    pub fn drain_events(&mut self) -> Vec<SessionEvent> {
        std::mem::take(&mut self.events)
    }

    /// 按方法名筛事件——浏览器自动化里最常用的消费方式（等 `Page.loadEventFired`）。
    pub fn events_named(&self, method: &str) -> Vec<&SessionEvent> {
        self.events
            .iter()
            .filter(|event| event.method == method)
            .collect()
    }

    /// 追加事件并按容量淘汰最旧的。
    fn push_event(&mut self, event: SessionEvent) {
        if self.events.len() >= EVENT_BUFFER_CAPACITY {
            // 丢最旧：`remove(0)` 是 O(n)，但容量只有 256，且这一步只在满缓冲时才走。
            self.events.remove(0);
        }
        self.events.push(event);
    }

    /// 放弃历史超限时按 id 最旧淘汰。
    fn prune_abandoned(&mut self) {
        while self.abandoned.len() > ABANDONED_HISTORY_CAPACITY {
            let Some(oldest) = self.abandoned.keys().next().copied() else {
                break;
            };
            self.abandoned.remove(&oldest);
        }
    }

    /// 某条 id 是否在放弃历史里（供上层归因，不参与路由）。
    pub fn was_abandoned(&self, id: CommandId) -> Option<AbandonReason> {
        self.abandoned.get(&id.0).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> CdpCommandSession {
        CdpCommandSession::new(1_000).expect("默认超时为 1000ms 应当合法")
    }

    fn response(id: u64, result: Value) -> InboundFrame {
        InboundFrame::Response {
            id: CommandId(id),
            result,
        }
    }

    fn failure(id: u64, code: i64, message: &str) -> InboundFrame {
        InboundFrame::Failure {
            id: CommandId(id),
            code,
            message: message.to_string(),
        }
    }

    #[test]
    fn 零超时窗口被拒绝() {
        assert_eq!(
            CdpCommandSession::new(0).unwrap_err(),
            SessionError::ZeroTimeout
        );
    }

    #[test]
    fn 登记后可查到在途() {
        let mut session = session();
        let registered = session
            .register(CommandId(1), "Page.enable", 100, None)
            .unwrap();
        assert_eq!(registered.deadline_ms, 1_100);
        assert_eq!(session.pending_count(), 1);
        assert!(session.is_pending(CommandId(1)));
    }

    #[test]
    fn 同id二次登记被拒绝且不覆盖原登记() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.enable", 100, None)
            .unwrap();
        assert_eq!(
            session
                .register(CommandId(1), "Page.navigate", 200, None)
                .unwrap_err(),
            SessionError::DuplicateId
        );
        // 关键：原登记**没有**被覆盖——响应仍投给第一条命令。
        match session.handle_frame(response(1, json!({})), 300) {
            RoutingVerdict::Routed { method, .. } => assert_eq!(method, "Page.enable"),
            other => panic!("应路由给先登记的命令，实际：{other:?}"),
        }
    }

    #[test]
    fn 单条命令的响应被正确路由并带上耗时() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.navigate", 100, None)
            .unwrap();
        match session.handle_frame(response(1, json!({ "frameId": "A" })), 350) {
            RoutingVerdict::Routed {
                id,
                method,
                outcome,
                elapsed_ms,
            } => {
                assert_eq!(id, CommandId(1));
                assert_eq!(method, "Page.navigate");
                assert_eq!(outcome, CommandOutcome::Ok(json!({ "frameId": "A" })));
                assert_eq!(elapsed_ms, 250);
            }
            other => panic!("应路由成功，实际：{other:?}"),
        }
        assert_eq!(session.pending_count(), 0);
    }

    #[test]
    fn 失败响应也路由且保留错误码() {
        let mut session = session();
        session
            .register(CommandId(4), "Runtime.evaluate", 0, None)
            .unwrap();
        match session.handle_frame(failure(4, -32000, "Cannot find context"), 10) {
            RoutingVerdict::Routed { outcome, .. } => assert_eq!(
                outcome,
                CommandOutcome::Err {
                    code: -32000,
                    message: "Cannot find context".to_string()
                }
            ),
            other => panic!("失败也应路由（不能当空结果吞掉），实际：{other:?}"),
        }
    }

    #[test]
    fn 两条并发命令的响应乱序到达时各归其主() {
        // 本模块存在的核心理由之一：绝不能用"最后一条在途"来配对。
        let mut session = session();
        session
            .register(CommandId(1), "Page.navigate", 0, None)
            .unwrap();
        session
            .register(CommandId(2), "Runtime.evaluate", 0, None)
            .unwrap();
        // 2 先回，1 后回。
        match session.handle_frame(response(2, json!({ "which": "two" })), 10) {
            RoutingVerdict::Routed { id, method, .. } => {
                assert_eq!(id, CommandId(2));
                assert_eq!(method, "Runtime.evaluate");
            }
            other => panic!("2 应路由给第二条，实际：{other:?}"),
        }
        match session.handle_frame(response(1, json!({ "which": "one" })), 20) {
            RoutingVerdict::Routed {
                id,
                method,
                outcome,
                ..
            } => {
                assert_eq!(id, CommandId(1));
                assert_eq!(method, "Page.navigate");
                assert_eq!(outcome, CommandOutcome::Ok(json!({ "which": "one" })));
            }
            other => panic!("1 应路由给第一条，实际：{other:?}"),
        }
    }

    #[test]
    fn 同一条响应被重复送达时第二次判孤儿() {
        // 成功路由后必须移除，否则重复回包会投给下一条复用同 id 的命令。
        let mut session = session();
        session
            .register(CommandId(7), "Page.enable", 0, None)
            .unwrap();
        assert!(matches!(
            session.handle_frame(response(7, json!({})), 5),
            RoutingVerdict::Routed { .. }
        ));
        match session.handle_frame(response(7, json!({})), 6) {
            RoutingVerdict::Orphaned { id, reason, .. } => {
                assert_eq!(id, CommandId(7));
                assert_eq!(reason, OrphanReason::NeverSeen);
            }
            other => panic!("重复响应应判孤儿，实际：{other:?}"),
        }
    }

    #[test]
    fn 从未发出的id的响应判孤儿_从未见过() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.enable", 0, None)
            .unwrap();
        match session.handle_frame(response(99, json!({})), 5) {
            RoutingVerdict::Orphaned { id, reason, .. } => {
                assert_eq!(id, CommandId(99));
                assert_eq!(reason, OrphanReason::NeverSeen);
            }
            other => panic!("未知 id 应判孤儿，实际：{other:?}"),
        }
        // 关键：不能因为收到孤儿就把在途的命令也清掉。
        assert!(session.is_pending(CommandId(1)));
    }

    #[test]
    fn 超时后到达的响应判孤儿_迟到而非从未见过() {
        let mut session = session();
        session
            .register(CommandId(3), "Page.navigate", 0, Some(500))
            .unwrap();
        assert!(matches!(
            session.sweep_timeouts(600),
            TimeoutSweep::Expired { .. }
        ));
        match session.handle_frame(response(3, json!({ "late": true })), 700) {
            RoutingVerdict::Orphaned {
                id,
                reason,
                outcome,
            } => {
                assert_eq!(id, CommandId(3));
                assert_eq!(reason, OrphanReason::ArrivedAfterAbandon);
                assert_eq!(outcome, CommandOutcome::Ok(json!({ "late": true })));
            }
            other => panic!("迟到响应应判孤儿(迟到)，实际：{other:?}"),
        }
    }

    #[test]
    fn 迟到响应不会被投给下一条复用同id的命令() {
        // 这是最贵的一类缺陷形态：响应迟到 + id 复用 = 结果串台且无人报错。
        //
        // 本测试最初写成「放弃后直接复用 id，期望迟到响应判孤儿」——**它失败了**，
        // 而且失败得正确：新命令确实在途，状态机无从分辨那条响应属于谁。
        // 这个失败暴露了原设计的漏洞：把防串台的责任推给了「id 单调递增」这个
        // 约定，而 `register` 接受调用方给的任意 id，约定并不受本模块保护。
        //
        // 修正后的设计：**放弃是「单方面不等」，不是「取消」**——对端可能已经
        // 把响应写出去了。因此放弃窗口内的 id **不得复用**，除非调用方显式放出。
        let mut session = session();
        session
            .register(CommandId(5), "Page.navigate", 0, Some(100))
            .unwrap();
        session.sweep_timeouts(200); // 第一条超时放弃。
        assert_eq!(
            session
                .register(CommandId(5), "Runtime.evaluate", 300, Some(1_000))
                .unwrap_err(),
            SessionError::IdInAbandonedWindow
        );
        // 迟到响应到达：id 不在在途表，判孤儿并标注「迟到」而非「从未见过」。
        match session.handle_frame(response(5, json!({ "stale": true })), 400) {
            RoutingVerdict::Orphaned { id, reason, .. } => {
                assert_eq!(id, CommandId(5));
                assert_eq!(reason, OrphanReason::ArrivedAfterAbandon);
            }
            other => panic!("迟到响应应判孤儿(迟到)，实际：{other:?}"),
        }
    }

    #[test]
    fn 显式放出放弃id后才能重新登记() {
        // 「连接已重建」的场景：旧连接的响应不可能再到达，此时才允许复用 id。
        let mut session = session();
        session
            .register(CommandId(9), "Page.enable", 0, None)
            .unwrap();
        session.abandon(CommandId(9), AbandonReason::Cancelled);
        assert_eq!(session.abandoned_count(), 1);
        assert_eq!(
            session.release_abandoned_id(CommandId(9)),
            Some(AbandonReason::Cancelled)
        );
        assert_eq!(session.abandoned_count(), 0);
        // 放出后即可重新登记。
        assert!(session
            .register(CommandId(9), "Page.navigate", 10, None)
            .is_ok());
        // 再放一次返回 None（幂等，不报错）。
        assert_eq!(session.release_abandoned_id(CommandId(9)), None);
    }

    #[test]
    fn 清空放弃历史后整批id可复用() {
        let mut session = session();
        for id in 1..=4 {
            session
                .register(CommandId(id), "X.method", 0, None)
                .unwrap();
            session.abandon(CommandId(id), AbandonReason::TimedOut);
        }
        assert_eq!(session.abandoned_count(), 4);
        assert_eq!(session.clear_abandoned(), 4);
        assert_eq!(session.abandoned_count(), 0);
        for id in 1..=4 {
            assert!(session.register(CommandId(id), "X.method", 0, None).is_ok());
        }
    }

    #[test]
    fn 放弃后同id仍被拒绝登记直到显式放出() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.enable", 0, None)
            .unwrap();
        assert!(session.abandon(CommandId(1), AbandonReason::Cancelled));
        assert_eq!(
            session.was_abandoned(CommandId(1)),
            Some(AbandonReason::Cancelled)
        );
        // 未放出前不可复用。
        assert_eq!(
            session
                .register(CommandId(1), "Page.navigate", 10, None)
                .unwrap_err(),
            SessionError::IdInAbandonedWindow
        );
    }

    #[test]
    fn 事件被记入缓冲且不影响在途登记() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.navigate", 0, None)
            .unwrap();
        let verdict = session.handle_frame(
            InboundFrame::Event {
                method: "Page.loadEventFired".to_string(),
                params: json!({ "timestamp": 12 }),
            },
            30,
        );
        assert_eq!(
            verdict,
            RoutingVerdict::IgnoredEvent {
                method: "Page.loadEventFired".to_string()
            }
        );
        assert_eq!(session.events().len(), 1);
        assert_eq!(session.events()[0].received_at_ms, 30);
        assert!(session.is_pending(CommandId(1)));
    }

    #[test]
    fn 事件按方法名筛选() {
        let mut session = session();
        for method in [
            "Page.loadEventFired",
            "Network.requestWillBeSent",
            "Page.loadEventFired",
        ] {
            session.handle_frame(
                InboundFrame::Event {
                    method: method.to_string(),
                    params: Value::Null,
                },
                0,
            );
        }
        assert_eq!(session.events_named("Page.loadEventFired").len(), 2);
        assert_eq!(session.events_named("Network.loadingFinished").len(), 0);
    }

    #[test]
    fn 事件缓冲有界且丢最旧() {
        let mut session = session();
        for index in 0..(EVENT_BUFFER_CAPACITY + 3) {
            session.handle_frame(
                InboundFrame::Event {
                    method: format!("Event.number{index}"),
                    params: Value::Null,
                },
                0,
            );
        }
        assert_eq!(session.events().len(), EVENT_BUFFER_CAPACITY);
        // 最旧的三条已被丢弃。
        assert_eq!(session.events()[0].method, "Event.number3");
        assert_eq!(
            session.events()[EVENT_BUFFER_CAPACITY - 1].method,
            format!("Event.number{}", EVENT_BUFFER_CAPACITY + 2)
        );
    }

    #[test]
    fn drain事件后缓冲为空() {
        let mut session = session();
        session.handle_frame(
            InboundFrame::Event {
                method: "Page.loadEventFired".to_string(),
                params: Value::Null,
            },
            0,
        );
        assert_eq!(session.drain_events().len(), 1);
        assert!(session.events().is_empty());
    }

    #[test]
    fn 坏帧被拒且带稳定原因() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.enable", 0, None)
            .unwrap();
        let verdict = session.handle_frame(
            InboundFrame::Invalid {
                reason: crate::frame::FrameInvalidReason::NotJson,
            },
            5,
        );
        assert_eq!(
            verdict,
            RoutingVerdict::Rejected {
                reason: RoutingRejectReason::InvalidFrame(
                    crate::frame::FrameInvalidReason::NotJson
                )
            }
        );
        // 拒绝原因必须**透传帧层的具体原因**，不能压成一个常量——
        // 压平后 `not_json` 与 `neither_response_nor_event` 无法区分。
        assert_eq!(
            RoutingRejectReason::InvalidFrame(crate::frame::FrameInvalidReason::NotJson).code(),
            "not_json"
        );
        // 坏帧不能误伤在途登记。
        assert!(session.is_pending(CommandId(1)));
    }

    #[test]
    fn 超时清扫报告超时命令并可重复调用() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.enable", 0, Some(100))
            .unwrap();
        assert_eq!(session.sweep_timeouts(50), TimeoutSweep::None);
        match session.sweep_timeouts(150) {
            TimeoutSweep::Expired {
                id,
                method,
                overdue_ms,
            } => {
                assert_eq!(id, CommandId(1));
                assert_eq!(method, "Page.enable");
                assert_eq!(overdue_ms, 50);
            }
            other => panic!("实际：{other:?}"),
        }
        // 幂等：同一条不会回报两次。
        assert_eq!(session.sweep_timeouts(200), TimeoutSweep::None);
    }

    #[test]
    fn 超时判定恰好在截止时刻生效() {
        // 边界方向必须是"到点即超时"（<= 而非 <），否则一条 timeout=1 的命令
        // 在 now=1 时还活着，语义会随实现细节漂移。
        let mut session = session();
        session
            .register(CommandId(1), "Page.enable", 0, Some(100))
            .unwrap();
        assert!(!session.sweep_timeouts(99).expired());
        assert!(session.sweep_timeouts(100).expired());
    }

    #[test]
    fn 超时清扫按id顺序确定性回报() {
        let mut session = session();
        for id in [3, 1, 2] {
            session
                .register(CommandId(id), "X.method", 0, Some(10))
                .unwrap();
        }
        let mut order = Vec::new();
        while let TimeoutSweep::Expired { id, .. } = session.sweep_timeouts(100) {
            order.push(id.0);
        }
        assert_eq!(order, vec![1, 2, 3]);
    }

    #[test]
    fn 未超时的命令不被清扫() {
        let mut session = session();
        session
            .register(CommandId(1), "Page.enable", 0, Some(100))
            .unwrap();
        session
            .register(CommandId(2), "Page.enable", 0, Some(1_000))
            .unwrap();
        assert!(matches!(
            session.sweep_timeouts(200),
            TimeoutSweep::Expired { id, .. } if id == CommandId(1)
        ));
        assert_eq!(session.pending_count(), 1);
        assert!(session.is_pending(CommandId(2)));
    }

    #[test]
    fn 放弃不在途的命令返回false且不报错() {
        let mut session = session();
        assert!(!session.abandon(CommandId(42), AbandonReason::TimedOut));
        assert_eq!(session.was_abandoned(CommandId(42)), None);
    }

    #[test]
    fn abandon_all清空在途并返回条数() {
        let mut session = session();
        for id in 1..=3 {
            session
                .register(CommandId(id), "X.method", 0, None)
                .unwrap();
        }
        assert_eq!(session.abandon_all(AbandonReason::Cancelled), 3);
        assert_eq!(session.pending_count(), 0);
        assert_eq!(
            session.was_abandoned(CommandId(2)),
            Some(AbandonReason::Cancelled)
        );
    }

    #[test]
    fn 放弃历史超限时淘汰最旧() {
        let mut session = CdpCommandSession::new(1_000).unwrap();
        for id in 1..=(ABANDONED_HISTORY_CAPACITY as u64 + 5) {
            session
                .register(CommandId(id), "X.method", 0, None)
                .unwrap();
            session.abandon(CommandId(id), AbandonReason::TimedOut);
        }
        // 最旧的 5 条已被淘汰，最近的仍在。
        assert_eq!(session.was_abandoned(CommandId(1)), None);
        assert_eq!(
            session.was_abandoned(CommandId(ABANDONED_HISTORY_CAPACITY as u64 + 5)),
            Some(AbandonReason::TimedOut)
        );
    }

    #[test]
    fn 每条命令可用自己的超时窗口覆盖默认值() {
        let mut session = CdpCommandSession::new(1_000).unwrap();
        let short = session
            .register(CommandId(1), "X.method", 0, Some(50))
            .unwrap();
        let long = session.register(CommandId(2), "X.method", 0, None).unwrap();
        assert_eq!(short.deadline_ms, 50);
        assert_eq!(long.deadline_ms, 1_000);
    }

    #[test]
    fn 单条命令零超时被拒绝() {
        let mut session = session();
        assert_eq!(
            session
                .register(CommandId(1), "X.method", 0, Some(0))
                .unwrap_err(),
            SessionError::ZeroTimeout
        );
    }

    #[test]
    fn 时刻回绕不产生下溢panic() {
        // now_ms 由调用方提供，可能是单调时钟的相对值；用 saturating 运算保证
        // 任何输入组合都不 panic——状态机在生产里 panic 会让整条会话不可恢复。
        let mut session = session();
        session
            .register(CommandId(1), "X.method", 10_000, None)
            .unwrap();
        match session.handle_frame(response(1, Value::Null), 0) {
            RoutingVerdict::Routed { elapsed_ms, .. } => assert_eq!(elapsed_ms, 0),
            other => panic!("实际：{other:?}"),
        }
    }

    #[test]
    fn 稳定错误码可被断言() {
        assert_eq!(AbandonReason::TimedOut.code(), "command_timed_out");
        assert_eq!(AbandonReason::Cancelled.code(), "command_cancelled");
        assert_eq!(OrphanReason::NeverSeen.code(), "orphan_never_seen");
        assert_eq!(
            OrphanReason::ArrivedAfterAbandon.code(),
            "orphan_arrived_after_abandon"
        );
        assert_eq!(
            RoutingRejectReason::InvalidFrame(crate::frame::FrameInvalidReason::EmptyMethod).code(),
            "empty_method"
        );
        assert_eq!(SessionError::ZeroTimeout.code(), "session_zero_timeout");
        assert_eq!(SessionError::DuplicateId.code(), "session_duplicate_id");
        assert_eq!(
            SessionError::IdInAbandonedWindow.code(),
            "session_id_in_abandoned_window"
        );
    }

    #[test]
    fn 事件带id之外字段仍不影响在途命令路由() {
        // 与 frame.rs 的判据呼应：事件（无 id）无论带什么参数字段都不参与路由。
        let mut session = session();
        session
            .register(CommandId(1), "Page.navigate", 0, None)
            .unwrap();
        session.handle_frame(
            InboundFrame::Event {
                method: "Custom.event".to_string(),
                params: json!({ "result": "looks-like-a-response" }),
            },
            5,
        );
        assert!(session.is_pending(CommandId(1)));
        assert_eq!(session.events().len(), 1);
    }
}
