# 参考项目能力融合与 AionUi 工作台映射

**日期**：2026-08-19
**原则**：仅吸收公开、可验证的高层架构和交互模式；以独立领域模型、命名、测试和实现落地。

## 能力融合矩阵

| 能力域 | 用户指定的重点参考 | b07-build 的独立落点 |
|---|---|---|
| Agent 编排与可回放执行 | DeepSeek-Harness、OpenWorker、ClawCode、OpenClaw、OpenCode、AtomCode | `agent-runtime`：DAG、事件协议、执行预算、上下文预算、后续运行快照与子 agent。 |
| 权限、审批与工具隔离 | Claude Code 官方文档、OpenCode、AtomCode、UI-TARS | `protocol` + `agent-runtime` + 后续 Rust 控制面：默认拒绝、显式审批、路径/命令风险与可审计 Hook。 |
| 模型路由与本地优先 | MiMo-Code、Jan、Cherry Studio、Chatbox、LobeHub | `provider-sdk`：稳定 driver port、任务路由、后续 provider 能力/成本/离线策略。 |
| 知识与文档工作流 | AnythingLLM、5ire、Open WebUI | Python sidecar：文档摄取、检索、证据引用；后续不可信扩展隔离。 |
| Cowork 工作台体验 | AionUi、UI-TARS、LobeHub、Cherry Studio | `apps/workbench`：持久侧栏、任务时间线、常驻预览、Agent/Context 状态和可编辑交付物。 |
| 调度与运营能力 | AionUi、OpenWorker、工作台类项目 | 后续计划任务页、任务恢复、审计导出与组织治理。 |

## AionUi 公开 UI 路径核查

AionUi 公开镜像的组件路径表明，其工作台以 `Layout`、`Sider`、会话消息、`SendBox`、`PreviewPanel`、`PreviewTabs`、浏览器和 Explorer 作为独立边界。b07-build 本轮采用相同的**布局分工**，但使用自己的组件实现和视觉 token：侧栏负责导航与工作区状态；中栏负责目标输入与事件流；右栏作为宿主级持久交付预览。

| AionUi 公开组件路径 | b07-build 对齐点 |
|---|---|
| `components/layout/Layout.tsx` | `App.tsx` 作为三栏工作台宿主。 |
| `components/layout/Sider/` | `components/layout/Sider.tsx` 品牌、工作区与导航容器。 |
| `components/chat/SendBox/` | `App.tsx` 的任务输入意图区；后续拆为独立 `TaskComposer`。 |
| `PreviewPanel/PreviewTabs` | `components/preview/PreviewPanel.tsx` 的宿主级多标签产物区。 |
| `Messages/MessagePlan`、`MessageThinking` | 当前事件时间线；后续增加事件专用展示组件。 |
| `explorer/ExplorerPanel` | 后续文件/产物导航切片。 |

## 公开来源

- https://github.com/bear20252026/AionUi
- https://github.com/anomalyco/opencode
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/permissions/
- https://github.com/atomgit-atomcode/atomcode
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/hooks

## 本轮 UI 验收

已在本地 Vite 工作台完成浏览器验收。三栏在桌面视图正常呈现：左栏包含品牌、任务入口、工作区导航与状态；中栏包含 Agent/Context/Runtime 状态、任务目标、事件时间线和输入区；右栏提供常驻预览与切换标签。输入新任务并点击“生成计划”后，UI 立即追加 `task.created` 与 `plan.proposed` 两条领域事件，任务标题与活动计数同步更新。该切片尚为前端意图演示，未连接真实 agent runtime、审批端口或持久化存储。
