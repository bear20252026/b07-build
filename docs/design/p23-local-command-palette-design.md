# P23：本地命令面板与受控导航设计

**日期：** 2026-08-21
**作者：** Manus AI
**状态：** 已实现，待全量集成验证

## 1. 目标

P23 提供一个可点击或通过 `Ctrl / ⌘ + K` 打开的本地命令面板，用于在聊天首页、当前任务页和设置二级页面之间快速跳转。它参考了现代工作台的快速定位模式，但不是命令执行器、Shell、自动化脚本入口或模型控制台。

## 2. 命令类型与管道

```text
createWorkbenchCommandCatalog(hasActiveTask)
  → projectWorkbenchCommands(query)
  → CommandPalette
  → App.executeCommand
  → setActivePage / focus composer / focus Inspector
```

| Action | 可执行效果 | 明确禁止 |
| --- | --- | --- |
| `navigate` | 切换到聊天首页、任务页或二级设置页面。 | 不附着 Gateway、不探测模型、不调用 Provider。 |
| `focus-task-composer` | 切换到首页并聚焦输入框。 | 不填充、提交或创建任务。 |
| `focus-task-inspector` | 切换到已有任务页并聚焦 Inspector。 | 不切换预览标签、不加载文件、不创建/下载 ZIP。 |

当前任务不存在时，目录不会暴露任务页和成果 Inspector 命令。检索仅对显式 label、description 和 keywords 做本地大小写不敏感过滤；不搜索文件、事件、任务目标、Provider 输出或任何持久化内容。

## 3. 架构边界

`command-catalog.ts` 和 `command-projection.ts` 是纯 TypeScript 模块，能独立在 Node 测试中验证。`CommandPalette.tsx` 只包含浏览器内键盘监听、筛选状态和回调；它不导入 Gateway client、SQLite、`process.env`、文件 API 或 Tauri invoke。实际导航和焦点行为由 App 的现有前端回调处理。

## 4. 归属与参考

P23 使用原创 TypeScript、React 与 CSS 实现。其“快捷定位但不隐藏副作用”的原则受到 AFFiNE 的工作区导航和 LobeHub 的高密度工作台组织启发。[1] [2] 未复制上游源文件、品牌、图标或样式；尤其不引入受 LobeHub Community License 约束的主仓组件实现。[3]

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE 官方仓库"
[2]: https://github.com/lobehub/lobehub "LobeHub 官方仓库"
[3]: https://github.com/lobehub/lobehub/blob/canary/LICENSE "LobeHub Community License"
