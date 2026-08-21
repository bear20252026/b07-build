# P22：独立任务页与类型化工作块设计

**日期：** 2026-08-21
**作者：** Manus AI
**状态：** 已实现，待全量集成验证

## 1. 页面职责

P22 将 P20 的「聊天首页」和已有 task/run 工作台彻底拆开：聊天首页始终保持为高频任务输入表面；当用户明确提交任务后，Workbench 切换到 `task` 页面；设置页继续由 `models`、`connections`、`operations`、`capabilities`、`security` 等显式意图驱动。这样旧 task/run 的存在不会把首页重新堆满运行面板，用户也能在侧栏的「当前任务」返回专注工作表面。

| 页面表面 | 进入条件 | 主要内容 | 禁止内容 |
| --- | --- | --- | --- |
| `chat-home` | `activePage = workspace` | 欢迎、工作方式、建议任务、输入岛、左下角设置入口。 | 任务详情、空 Inspector、设置表单。 |
| `task-page` | `activePage = task` 且已有 task/run。 | 类型化工作块、活动、成果、审批/恢复、既有 Inspector。 | 新的状态源、自动执行、直接文件读取或 Provider 调用。 |
| `settings` | 所有复杂控制面页面。 | 模型、连接、运行记录、扩展、安全与系统。 | 高密度任务会话与隐式任务动作。 |

## 2. 组件管道

```text
WorkbenchTaskSnapshot / events / files / deliveries
  → task-page-projection.ts (pure)
  → TaskPage.tsx (view + explicit callbacks)
  → App.tsx (existing Gateway intents)
  → PreviewPanel (existing controlled review)
```

`task-page-projection.ts` 固定输出 Intent、Execution、Review、Outcomes 四个块，且只从已有脱敏 task/run metadata 计算文本和状态色。`TaskPage.tsx` 不导入 HTTP client、不拥有数据库或文件状态；其审批、恢复、审查成果和返回聊天均是父组件注入的明确回调。

## 3. 交互规则

任务提交成功后显式切换到 `task` 页。返回聊天只切换前端页面意图，既不停止 Gateway，也不取消或修改 task/run。任务页上的「审查成果」只聚焦右侧 Inspector；被阻塞或失败的任务可显示既有审批/恢复动作，但不会自动批准、自动恢复或重放副作用。

## 4. 上游参考与归属

P22 仅借鉴 AFFiNE 的“页面承载块式工作上下文”与 LobeHub 的“任务、活动和成果在同一工作单位中可追踪”的产品模式。[1] [2] 代码、样式、图标与文案均为原创；不复制 LobeHub Community License 主仓实现。若将来复用确认的 AFFiNE MIT 文件，必须保留其版权和许可证。[3]

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE 官方仓库"
[2]: https://github.com/lobehub/lobehub "LobeHub 官方仓库"
[3]: https://github.com/toeverything/AFFiNE/blob/canary/LICENSE-MIT "AFFiNE MIT License"
