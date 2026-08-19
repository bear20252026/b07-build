# OpenClaw 本地优先运行时研究笔记

**日期**：2026-08-19
**使用边界**：仅提取公开文档与公开仓库可验证的架构原则；不导入来源不明或未授权实现。

## 公开观察

| OpenClaw 公开设计 | b07-build 的独立落点 |
|---|---|
| 每个 Agent 拥有工作区、bootstrap 文件和独立会话存储。 | 引入本地任务快照的领域接口，使任务、Profile、运行状态和预算能在恢复时重新装配。 |
| 活动会话历史存入每 Agent SQLite；遗留 JSONL 仅作为迁移输入。 | 先定义 storage port 和内存适配器，后续用 SQLite append-only 实现替换，不让 UI 或工具层直连持久化。 |
| 中途新消息可在下一个工具启动检查点转向，未启动的顺序调用可跳过，运行中的调用不被错误中断。 | 为 DAG 调度器预留取消/转向 token；下一阶段实现 launch checkpoint，保证已运行节点与未启动节点语义清晰。 |
| Gateway 统一管理 sessions、tools、events 和 channels，UI/CLI/TUI 通过控制面连接。 | 将 TypeScript Agent runtime 保持为任务语义层；让 Rust `process-supervisor` 演进为生命周期、心跳和取消控制面，而非掺入模型逻辑。 |
| 工具的存在与权限策略分离；工作区说明文件只影响行为指导而不是权限强制。 | 保持 `CapabilityPolicy` / `ApprovalPort` 为唯一权限边界，Profile 与 prompt 不得放宽策略。 |

## 本轮优先实现切片

先实现**可序列化任务运行快照**和**任务恢复注册表端口**：当执行器启动、节点完成或被阻断时，运行时将保留 task/run/profile、节点状态、调度统计和预算关联，后续 SQLite 适配器与 Rust 控制面只消费这个稳定快照。该切片让 b07-build 获得本地优先、可恢复的核心语义，不把持久化或跨语言逻辑塞进 DAG 调度器。

## 公开来源

- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai/concepts/agent
- https://docs.openclaw.ai/concepts/sessions
- https://github.com/XiaomiMiMo/MiMo-Code
- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/andrewyng/openworker
- https://github.com/anomalyco/opencode
