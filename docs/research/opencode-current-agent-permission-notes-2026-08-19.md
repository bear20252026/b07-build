# OpenCode 当前公开设计研究：Agent 与权限

**调研日期**：2026-08-19  
**用途**：仅提取公开文档中的高层产品和架构模式，形成 AI Work OS 的独立实现。

## 公开观察与本地化决策

| OpenCode 公开设计 | 可融合的产品模式 | AI Work OS 的独立决策 |
|---|---|---|
| Primary Agent 与 Subagent 区分，Build/Plan 是可切换主角色，Explore/Scout 是专门子角色 | 在工作台将“当前主角色”与“可委派专长角色”拆成不同概念，避免所有任务混入一个万能 Agent | 现有 Build/Plan/Explore Profile 保持为权限收紧策略；下一阶段增加显式 `AgentRole` 和受控 `SubtaskIntent`，Profile 不承担 persona 或工作区隔离职责 |
| Agent 包含 prompt、模型、工具权限、显示元数据和步骤上限 | 把可呈现的角色设置同执行预算一并记录，便于复现和回放 | `AgentRole` 只保存描述、默认模型偏好和预算上限；所有能力仍经过全局默认拒绝策略、审批和预算器 |
| Plan 默认令写入和 Shell 进入 ask/deny 流 | 分析模式必须无副作用或显式审批 | 当前 Plan 已拒绝写入和 Shell；保持现有“基线拒绝不能被 Profile 放宽”铁律，不采用可能扩大权力的合并规则 |
| 子 Agent 可被主 Agent 或用户显式触发，并支持父子会话导航 | 子任务必须具备 parent run、目标、预算、事件与完成摘要，工作台可以查看关系而不是只看线性日志 | 新增 `SubtaskIntent` / `SubtaskSnapshot` 前先完成 Session Control Plane；子任务不直接继承无限制工具和跨会话内容 |
| 工具权限可按命令或路径粒度表达 allow/ask/deny | 保留风险/能力/作用域的细分审批语言 | 现有 `CapabilityPolicy` 以能力为中心；后续在可信工具适配器内部增加受控路径/命令 matcher，不能暴露未经验证的模式给 UI |
| `always` 授权只持续当前会话 | 临时偏好不能悄然成为永久能力升级 | 审批决策将以 `scope=once|task|session` 显式记录；永久策略变更必须由本地设置控制面发起并单独审计 |

## 候选后续切片

在 Session Control Plane 之后实现 **受控子任务 v1**：

1. 主任务创建包含 `parentRunId`、`roleId`、`goal`、`budget` 的 `SubtaskIntent`。
2. 父运行时只能调用明确 allowlist 的只读 Explore / Scout 角色；默认不继承写入、Shell、浏览器或网络能力。
3. 每个子任务获得独立事件流、快照与最终有界摘要；父任务只能消费摘要和带来源的产物引用。
4. 工作台通过树状/关系视图呈现父子任务，但只向本地网关发送意图，不能直接创建任意子 Agent。
5. 角色切换、预算和审批决策都成为可回放协议事件。

## 官方来源

1. [OpenCode Agents](https://opencode.ai/docs/agents/)
2. [OpenCode Permissions](https://opencode.ai/docs/permissions/)
