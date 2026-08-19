# OpenClaw 当前公开架构研究：Gateway、会话与多 Agent

**调研日期**：2026-08-19  
**用途**：仅提取公开文档中的高层架构原则，形成 AI Work OS 的独立设计；不导入上游实现或运行指令。

## 已验证观察

| OpenClaw 公开能力 | 对 AI Work OS 的可融合原则 | 当前差距与独立落点 |
|---|---|---|
| 单宿主 Gateway 以 typed WebSocket 连接控制端、节点与事件订阅者 | UI/CLI/桌面端只经版本化控制面提交意图、订阅事件；运行时和存储不被 UI 直连 | 现有 loopback HTTP gateway 已建立 DTO 边界；下一步定义 versioned WS/JSON-RPC gateway port 与握手能力发现 |
| 副作用请求使用幂等键，并在客户端重试时去重 | `submit`、`resume`、`approve` 均必须具有意图键；同一键只产生一次任务或审批决定 | 现有 task/run ID 可承载去重；补齐 `idempotencyKey` 契约与持久化 request receipt store |
| Gateway 拥有 session；客户刷新快照以弥补事件缺口 | 事件订阅永远与 snapshot read 模型配对；断线/丢事件后以版本号重新同步而不猜测 UI 状态 | 现有 `snapshot` / `events` 端点；补齐单调 `stateVersion`、`sinceVersion` 和 gap reset 语义 |
| Agent 拥有 workspace、state dir、auth、session store 的独立边界 | Agent Profile 不等于 persona/工作区；未来 persona 必须用独立 `agentId`、工作区与会话命名空间隔离 | 现有 Profile 是权限收紧策略；新增 `LocalAgentIdentity` 与 `SessionScope` 领域模型，不能复用 Profile ID 充当隔离键 |
| Durable/Incognito 会话是显式模式；历史检索做脱敏、有界输出 | 本地任务必须能够区分 durable、ephemeral、incognito；跨会话检索只返回有来源、截断、脱敏的引用结果 | 现有 SQLite task snapshot 和知识引用；下一步实现 session metadata store 与 privacy mode，禁止把原始工具结果作为检索内容 |
| Agent 间的工具、共享记忆与提升权限均显式配置、只能进一步收紧 | 保持默认拒绝；共享知识目录与 agent-to-agent 消息均使用显式 allowlist，不能通过 prompt 或 Profile 放宽 | 现有 CapabilityPolicy / ProfiledCapabilityPolicy；新增 Agent-to-Agent routing port 时复用审批与策略边界 |

## 候选的下一增量：会话控制面 v1

优先实现一个纯领域层的 **Session Control Plane v1**，而不是先接入聊天渠道或外部 IM。它应包括：

1. 可版本化 `SessionScope`：`agentId`、`workspaceId`、`sourceKind`、`sourceId` 与持久化模式。
2. 显式 `durable | ephemeral | incognito` 模式；incognito 不写 transcript 或检索索引，但仍保留内容无关审计元数据。
3. `SessionSnapshotStore` append-only 端口及 SQLite 适配器；保留 `stateVersion`、`lastInteractionAt` 与恢复所需摘要。
4. 只读 `SessionControlService`：创建、读取、列表、reset、archive、pin；浏览器仅消费防御性 DTO。
5. 事件缺口恢复：客户端以 `stateVersion` 读取 snapshot，不尝试由前端自行重建状态。
6. 副作用幂等：任务 submit/approve/resume 将在后续网关版本中接入持久化 receipt。

> 该切片优先解决个人学习产品的可恢复会话与隐私模式；多渠道接入、远端节点配对和外部账号登录均延后，避免在控制面未稳固前扩展攻击面。

## 官方来源

1. [Gateway architecture](https://docs.openclaw.ai/concepts/architecture)
2. [Session management](https://docs.openclaw.ai/concepts/session)
3. [Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent)
