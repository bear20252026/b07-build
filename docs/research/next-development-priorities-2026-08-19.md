# AI Work OS：下一阶段开发优先级与内存管理决策

**结论**：下一步不应先堆更多模型、MCP 或聊天页面；应先将 v0.13 的任务与会话快照升级为可靠本地控制协议，并建立可审查的 **Memory Ledger**。这两项是扩展多 Agent、知识库、本地模型和桌面端前必须具备的“状态真相层”。

## 建议排序

| 顺序 | 增量交付 | 主要借鉴模式 | 解决的问题 | 完成标准 |
|---|---|---|---|---|
| **P0 / v0.14** | Session/Task Control Gateway v1 | OpenClaw 的 gateway-owned session、typed event、snapshot refresh；ClawCode 的控制面 | 浏览器重试、断线与刷新会产生重复任务或过期 UI 状态 | submit/approve/resume 需要幂等键；request receipt 持久化；事件带 stateVersion；版本缺口后客户端刷新 snapshot |
| **P0 / v0.15** | Memory Ledger v1 | OpenClaw 分层记忆与 compaction flush；Open WebUI memory type/path/budget | 不能把完整聊天和检索片段无序塞入模型上下文 | append-only memory revision、candidate/confirmed/retracted 状态、scope、来源、token estimate、expiry、预算化选择 |
| **P1 / v0.16** | Context Assembly & Compaction v2 | OpenClaw 保留最近尾部与工具配对、严格 identifier、压缩前 flush；DeepSeek 可回放 session log | ContextBudgeter 只按 priority 丢项目，无法治理摘要质量 | L0-L4 分层输入、每条注入输出 reason/citation/token、压缩失败保留原状态、model-visible 输入均可回放 |
| **P1 / v0.17** | Local Model Endpoint Registry | Jan 本机引擎、Cherry Studio 多模型、现有确定性 Router | 当前路由不知道本地 runner 是否健康、可用或容量不足 | loopback endpoint 探测、capability/context/version 状态、离线原因与 deterministic route explanation |
| **P2 / v0.18** | Knowledge Workspace & Retrieval Plan | AnythingLLM workspace、Open WebUI chunk/version/reindex、5ire 本地知识 | 知识库没有 workspace scope、index generation 或显式 retrieval plan | 文档/索引按 workspace 隔离；chunk/index 配置版本化；检索可解释、可重建、可重新索引 |
| **P2 / v0.19** | Read-only Subtask + Runtime Preset | OpenCode Explore/Scout、DeepSeek runtime mode、OpenClaw agent isolation | 子任务会扩大权限、继承过多上下文或无法回放 | 子任务预算隔离，默认只读，父任务只能取摘要/引用，preset 只能收紧能力 |
| **P3 / v0.20** | MCP Registry Manifest | 5ire/ Open WebUI MCP 的扩展目录体验 | 插件与 MCP 很容易变成不透明的远程执行入口 | manifest、发布者/版本/能力摘要/信任状态/审批历史；不自动安装或运行 server |

## Memory Ledger 的建议结构

```text
MemoryRecord
  id, revision, status(candidate|confirmed|superseded|retracted)
  kind(preference|durable_fact|working_note|decision|pending_intent)
  scope(agentId, workspaceId, sessionId?, path)
  contentRef / excerpt / estimatedTokens
  provenance(sourceType, sourceId, citations, trust)
  lifecycle(createdAt, updatedAt, expiresAt?, supersedes?)
```

它只存储**经过范围、来源和状态标记的记忆**。它不持有原始 provider transcript、模型内部 reasoning、未脱敏工具输出或可直接执行的权限决定。对于 `pending_intent`，记录可帮助后续会话理解“为什么尚不能执行”，但 CapabilityPolicy 和 ApprovalPort 仍负责实时强制。

## 内存管理的技术策略

| 层级 | 存储与生命周期 | 进入模型的条件 | 性能策略 |
|---|---|---|---|
| L0 当前 turn | 进程内 | 当前请求、必需工具响应、最近事件 | 设硬 token 上限；不要持久化为记忆 |
| L1 Session working set | SQLite session metadata 与有界摘要 | 仅当前 session、未完成目标、最近有效引用 | 近期优先；过大先 flush candidate 再压缩 |
| L2 Durable memory | SQLite append-only revision | confirmed 且 scope 匹配、未过期、预算允许 | preference / context 分别预算；重复和矛盾需显式修订 |
| L3 Knowledge workspace | SQLite 文档与索引 generation | 用户或任务显式选择的 workspace 检索结果 | chunk 结构化、避免小碎片、index 配置变动触发新 generation |
| L4 Archive | SQLite 任务/会话历史 | 默认不注入；只用于诊断、回放或明确检索 | 定期归档、pin/保留策略、无需每次 session 启动扫描 |

## 借鉴边界

OpenClaw 的本地会话、分层记忆、压缩前保存和隔离 agent 设计，最适合成为状态控制基础。OpenCode 的 Build/Plan/Explore 角色与粒度权限，适合在 Session/Memory 边界稳定后扩展子任务。DeepSeek Harness 的可替换 capability seam 与轨迹可追溯性，应体现为封闭 manifest 与 adapter port，而不是运行时加载不受控代码。AnythingLLM、Open WebUI、5ire 与 Jan 的知识、多模型、MCP 和本地模型体验，应该建立在 workspace scope、index generation、endpoint health 和显式审批之上。

## 当前建议

**建议立即开发 Memory Ledger v1，而不是直接添加更多 MCP 或模型连接器。** 同时并行设计 Session/Task Gateway v1 的幂等 DTO，但不要在没有持久化 request receipt 的情况下向 UI 暴露自动重试。Memory Ledger 可先采用纯 TypeScript + SQLite append-only + deterministic lexical search，后续再接入本地 embedding / reranker。这样能以最小复杂度获得可审查、可恢复、可解释的长期记忆基础。
