# OpenCode 与 ClawCode 调度优化研究笔记

**日期**：2026-08-19
**使用边界**：仅提取公开、可验证的调度与运行时设计原则；不复制不明来源实现。

## 公开观察

| 公开项目 | 观察到的高层设计 | 对 b07-build 的独立优化含义 |
|---|---|---|
| OpenCode | 官方公开文档将 primary agent、subagent、最大步骤数与每个 agent 的权限分开配置；会话、任务和工具权限保持解耦。 | DAG 执行器应接收独立的调度选项（并发度、步骤预算）而非让 UI 或工具端口决定执行顺序。 |
| ClawCode | 公开 Rust runtime 使用任务注册表管理 Created/Running/Blocked/Completed/Failed/Stopped 生命周期；lane 事件带有单调序号、来源、指纹和健康度。 | 执行器应采用线性预编译 DAG 与完成驱动的 ready queue，避免每轮扫描所有 pending 节点；事件可保留稳定顺序并为后续 Rust supervisor 提供调度统计端口。 |
| b07-build 当前实现 | 现有执行器在每个 wave 内串行 `await`，并使用 `nodes.find` 校验依赖、`pending.values().filter` 重复扫描就绪节点。 | 需要改为索引化拓扑校验和固定并发上限的工作池，使同一 wave 的独立节点并发执行，仍保持每个节点的 called → result 事件顺序。 |

## 本轮优化决策

1. 引入 `DAGExecutionOptions`：以显式 `maxConcurrency` 限制并行工具调用，默认值保持保守。
2. 预编译节点索引、入度和反向依赖索引：验证未知依赖、重复 ID 与环，并在每个节点完成时仅更新直接后继。
3. 使用完成驱动的 ready queue：不再扫描 pending 集合；独立节点以确定性顺序入队，同时通过工作池并行执行。
4. 新增 `DAGExecutionStats` 观测端口：记录节点总量、最大并行度、启动/完成数量和失败数量，留给后续 Rust `process-supervisor`/事件日志消费。
5. 保留安全边界：此优化不改变 `ControlledToolRunner` 的权限、审批与预算门控；并发只发生在已经由调用方调度的独立 DAG 节点之间。

## 公开来源

- https://github.com/anomalyco/opencode
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/permissions/
- https://github.com/ultraworkers/claw-code
- https://raw.githubusercontent.com/ultraworkers/claw-code/main/rust/crates/runtime/src/task_registry.rs
- https://raw.githubusercontent.com/ultraworkers/claw-code/main/rust/crates/runtime/src/lane_events.rs

## 本轮基准结果

使用仓库内 `npm run benchmark:dag` 在同一 Node.js 进程中执行 24 个彼此独立、每个模拟 5ms I/O 的工具节点。`maxConcurrency=1` 的串行执行耗时 **130.82ms**；`maxConcurrency=4` 的受控工作池耗时 **31.62ms**，最大观测并发度为 4，得到约 **4.14×** 加速。本基准只量化 DAG 调度和异步 I/O 等待重叠，不代表模型、网络、sidecar 或真实工具的端到端吞吐；其用途是防止调度器退化回串行全量扫描。
