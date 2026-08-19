# 分层记忆、上下文压缩与检索治理：公开模式研究

**调研日期**：2026-08-19  
**用途**：为 AI Work OS 个人本地学习产品设计可恢复、可解释、用户可控的记忆系统；不导入上游实现。

## 已验证模式

| 公开模式 | 适合吸收的原则 | AI Work OS 独立设计 |
|---|---|---|
| OpenClaw：`USER.md`、`MEMORY.md`、每日工作笔记、Dream Diary 分层 | 将稳定偏好、经确认长期事实、短期工作笔记、回顾产物分开，而非将整段聊天复制进 prompt | `MemoryKind = preference | durable_fact | working_note | decision | pending_intent`，每条记录必须有来源、作用域、状态和更新时间 |
| OpenClaw：压缩前 memory flush；上下文只摘要旧记录，完整历史仍留存 | 压缩前先生成候选记忆，再压缩模型上下文；摘要失败必须保留原始状态而不是丢上下文 | `MemoryCandidate` 需要先经过 deterministic gate 和人工/策略确认；上下文摘要是可回放事件，不能覆盖 durable fact |
| OpenClaw：混合检索、隔离的 agent memory、action-sensitive memory 不代替 policy | 检索和记忆记录不能获得执行权限；含审批、过期和来源的行动提示必须显式标注 | 检索结果以 citation + trust + expiry 返回；CapabilityPolicy/ApprovalPort 仍是唯一强制边界 |
| Open WebUI：memory type/path、独立注入预算、可审查/删除 | 用户偏好与一般上下文分别预算；所有长期记忆可见、可编辑、可删除 | 记忆记录按 `scopePath` 分层，`preference` 与其他类型使用不同 budget；工作台后续提供独立 Memory 管理区 |
| Open WebUI：结构化 chunk、最小 chunk 合并、embedding 变化触发 reindex | 文档结构与 index 配置必须带版本；避免小碎片造成噪声和索引膨胀 | `KnowledgeWorkspace` 将记录 chunker/embedding/index version；配置变化创建新 index generation，不混用向量空间 |

## 推荐的分层记忆模型

```text
L0  当前 turn 的已验证输入与最近事件（内存，短寿命）
L1  Session working set：当前 session 摘要、未完成任务、最近关键引用（SQLite，受 context budget 控制）
L2  Durable memory：偏好、确认事实、决策、显式 intent（SQLite + append-only 修订）
L3  Knowledge workspace：原始文档、chunks、稀疏/向量索引、来源引用（SQLite / 可替换 adapter）
L4  Archive：旧 session / task snapshot / 审计元数据（SQLite，默认不注入模型）
```

## 强制不变量

1. **记忆不是权限**：任何 `pending_intent`、历史审批或文档指令都不能绕过当前策略与审批。
2. **记忆不是 transcript**：原始工具结果、敏感内容和内部 reasoning 不自动升格为 durable memory。
3. **所有注入可解释**：每一条送入模型的记忆必须返回 memory id、kind、scope、score、来源与 token 估计。
4. **所有提升可复核**：从 L1/L3 到 L2 的提升需要 provenance、candidate reason、dedupe/contradiction 检查和明确 review 状态。
5. **索引配置有版本**：chunker、embedding、normalizer 变化产生新 generation；禁止混合不同向量空间。
6. **incognito 不泄漏**：incognito session 不进入 L2/L3，也不能触发自动 promotion。

## 推荐首个实现切片：Memory Ledger v1

不先做自动“梦境总结”或模型自主写记忆。先实现一个纯领域层 `MemoryLedger`：

- append-only `MemoryRecord` 和 revision；
- `candidate | confirmed | superseded | retracted` 状态；
- scope path、agent/workspace/session 边界；
- source citation、trust 标签、expiry 和 token estimate；
- SQLite store、list/search（确定性词法）与预算化 `selectForContext()`；
- 默认只有显式用户确认或可信本地流程能把 candidate 升格为 confirmed；
- 不运行模型、不执行工具、不自动读取 transcript。

它为后续 local embedding recall、session compaction memory flush、知识工作区融合和可视化 review 提供安全基础。

## 官方来源

1. [OpenClaw Memory overview](https://docs.openclaw.ai/concepts/memory)
2. [OpenClaw Compaction](https://docs.openclaw.ai/concepts/compaction)
3. [Open WebUI Memory & Personalization](https://docs.openwebui.com/features/chat-conversations/memory/)
4. [Open WebUI RAG](https://docs.openwebui.com/features/chat-conversations/rag/)
