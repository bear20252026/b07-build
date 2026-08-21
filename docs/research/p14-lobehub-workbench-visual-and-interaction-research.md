# P14：LobeHub 工作台视觉与交互模式调研

**日期：** 2026-08-21
**目标：** 将 Windows AI Work OS 的核心工作区向 LobeHub 的 Agent 协作、任务可见性和高密度界面层级靠拢，同时保持本地优先、受控执行和 Windows 桌面安全边界。

## 1. 参考边界与许可证

| 项目 | 可验证事实 | 本轮采用方式 |
|---|---|---|
| LobeHub 主产品 | 官方 README 将其定位为以 Agent 为工作单元的协作平台，围绕 Agent 招募、调度、汇报、群组、页面、项目与工作区组织工作。[1] | 仅借鉴产品信息架构、交互模式和视觉原则；不复制 LobeHub 主仓库源码或品牌资源。其当前许可证为 **LobeHub Community License**，不能默认当作可任意复制的 MIT 代码。 |
| Lobe UI | 官方 UI Kit 说明其面向 AIGC 场景，包含聊天 Markdown、高亮、主题、响应式、国际化和 AI 模型图标等设计基础；仓库为 MIT 许可证。[2] [3] | 采用其可复用的设计思想：token 化主题、紧凑信息密度、层级化表面、统一聊天/代码/状态组件体验。现有 Workbench 不引入其运行时依赖，以避免 CSP、依赖体积和架构边界风险。 |
| LobeHub 源码结构 | 官方 `src/features` 目录将 `AgentSidebar`、`AgentTasks`、`TaskManager`、`Conversation`、`FileTree`、`FileViewer`、`RightPanel`、`CommandMenu`、`DesktopLayoutContainer` 等职责分拆。[4] | 采用“导航 / 主工作台 / 右侧检查器”三面板职责划分；将任务、文件、代码预览和交付包继续保持为独立组件与 DTO，而不将其混入对话事件文本。 |

> **许可决策：** 用户要求“可照搬”不改变上游许可证。P14 不复制 LobeHub Community License 代码；对于 MIT 的 Lobe UI，只在未来确有必要时按许可证保留版权与许可声明后使用明确的独立组件。当前交付使用原创 React/CSS 组件实现，参考公开的设计思想而非复制实现。

## 2. 可本地化的核心模式

LobeHub 的核心不是单一聊天窗口，而是让 Agent、任务、项目、文件和协作上下文在一个持续工作表面上保持可见。[1] 因此 AI Work OS 应把当前“任务提交 → 事件 → 右侧预览”的布局进一步改造成由 **工作台导航、任务上下文头、执行时间线、任务成果检查器**组成的稳定操作面。

| LobeHub 模式 | AI Work OS 本地化实现 |
|---|---|
| Agent 是工作单元 | 当前 task/run 保持为受控执行单元；视觉上增加清晰的任务身份、执行状态和权限标签，绝不把 Agent 的样式暗示为无边界自治。 |
| 项目/工作区组织 | 左侧导航通过“工作区 / 模型连接 / 运行记录 / 扩展 / 安全”保持低频控制面分区；在工作区态将当前任务与任务文件显示为高频对象。 |
| 高密度协作页面 | 中部对话区使用上下文头、任务状态卡、阶段时间线与紧凑操作区；右侧保持文件、代码、差异、交付包、引用的 Inspector，支持立即审查。 |
| 主题与视觉 token | 延续现有 light/dark 与 Apple 优先系统字体策略，增加更明确的 surface 层级、统一圆角/阴影、可读的 monochrome metadata、带色状态语义和键盘焦点。 |
| 任务可见性 | 将运行步骤、审批、产物数量和交付包以可点击且不替代审批的显示层呈现；不把持久化文件或密钥直接放入聊天。 |

## 3. P14 视觉系统方向

工作区采用温和冷灰背景、半透明白色主表面、低饱和蓝紫作为主要操作色、绿色/琥珀/红色作为状态色。每个操作只有一个明确主按钮；次级操作以 text button 或细边框出现。信息不依赖装饰图标来表达权限，高风险状态仍由可见文本和状态标签说明。

```
┌────────────┬───────────────────────────────────────┬────────────────────┐
│ Workspaces │ Task context + execution conversation │ Task inspector     │
│ Models     │ status / approval / activity timeline │ files / code / ZIP │
│ Operations │ focused composer                       │ citations          │
└────────────┴───────────────────────────────────────┴────────────────────┘
```

重点是让用户在一次桌面窗口中明确知道：**当前是什么任务、谁在执行、需要什么批准、产生了哪些文件、能交付什么**。右侧检查器不承担文件系统浏览器角色，仅查看当前 task/run 的受控产物。

## References

[1]: https://github.com/lobehub/lobehub "LobeHub GitHub repository and README"
[2]: https://ui.lobehub.com/ "LobeHub UI Kit"
[3]: https://github.com/lobehub/lobe-ui "Lobe UI GitHub repository and MIT license"
[4]: https://github.com/lobehub/lobehub/tree/canary/src/features "LobeHub feature directory"
