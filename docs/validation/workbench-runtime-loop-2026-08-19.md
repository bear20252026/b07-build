# 工作台本地运行时闭环验收记录

**验收日期：** 2026-08-19  
**验收范围：** `apps/workbench` 通过本地 HTTP 网关连接 `LocalTaskRuntimeService`、SQLite 快照和受控执行链。

| 步骤 | 观察结果 | 结论 |
|---|---|---|
| 启动 | 工作台初始界面展示“本地快照 / 等待任务”，且事件区域为空 | UI 未伪造执行事件 |
| 提交 Build 目标 | 网关返回 `blocked` 快照，节点为 `understand=ok`、`inspect=ok`、`deliver=blocked` | 高影响写入意图被审批门控；SQLite 快照成功返回 |
| 事件展示 | 工作台显示 `task.created`、Profile、计划、两次成功工具调用、`approval.required` 与被阻断的工具结果 | 浏览器客户端通过封闭事件协议消费真实网关事件 |
| 审批并恢复 | 点击“批准并恢复 deliver”后快照变为 `completed`、attempt 从 1 增至 2、事件数由 9 增至 12 | 恢复仅重跑 `deliver`，未重新执行已成功节点 |
| 无副作用保证 | 演示网关的 `workspace.write.intent` runner 只返回 `local://` 输出引用，不写文件、不执行 Shell、不开网络 | 端到端 UI 验收没有引入实际高影响副作用 |

> 本验收揭示并修复了一处协议漂移：受控工具的 `tool.result` 在审批/预算阻断时会携带 `blocked`，而原封闭 JSON Schema 未声明该字段。现已将该字段纳入类型与 Schema，并重新通过全部自动化检查。
