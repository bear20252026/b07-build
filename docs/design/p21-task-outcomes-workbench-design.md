# P21：块式任务成果与显式交付设计

**日期：** 2026-08-21
**作者：** Manus AI
**状态：** 已设计，待实现与验证

## 1. 目标

P21 在已有 task/run 故事板与五标签 Inspector 之间增加原创的 **Task Outcomes（任务成果）** 块。它将当前 task/run 已有的文件 metadata 和最近交付收据压缩成可扫描的审查摘要，并提供两项明确、可预测的后续动作：将焦点交给现有 Inspector，或在已有文件时显式创建 ZIP 交付包。

这个改进采纳 AFFiNE 的“工作单位由可组合、可独立阅读的块构成”原则，以及 LobeHub 将工作、活动与产物保持关联的产品方向。[1] [2] P21 不复制 AFFiNE 或 LobeHub 的源文件、依赖、图标、品牌或运行时；完整许可判断见 P21 调研记录。[3]

## 2. 用户路径

| 阶段 | 用户看到的块 | 明确可用动作 | 不会发生的事情 |
| --- | --- | --- | --- |
| 尚未有成果 | 说明 task/run 尚未产生可审查文件。 | 查看 Inspector（只聚焦）。 | 不显示伪造文件，不创建 ZIP，不下载任何内容。 |
| 已有任务文件 | 最多三个近期文件的显示名、逻辑路径、版本、媒体类型与大小。 | 在 Inspector 中审查；显式创建 ZIP。 | 不读取正文、不显示绝对路径、摘要、hash、prompt 或密钥。 |
| 已有交付包 | 最近一个 ZIP 收据的文件数、总大小和可用状态。 | 在 Inspector 中审查/下载（原有流程）。 | 不自动下载、解压或执行 ZIP。 |

> 创建 ZIP 仍是用户点击后向本机 Gateway 发送的既有显式 intent；它不是模型调用，也不会访问第三方 Provider。

## 3. 数据与权限边界

`TaskOutcomeBoard` 只接收已经由 App 水合的 `WorkbenchTaskFile[]`、`WorkbenchTaskDeliveryReceipt[]` 和无副作用回调。纯投影层按 `createdAt` 排序，限制展示数量为三项，统一格式化大小；它不会创建网络请求、SQLite 查询、文件读取或任何凭据处理。

| 输入字段 | P21 是否显示 | 原因 |
| --- | --- | --- |
| `displayName`、`logicalPath`、`version`、`mediaType`、`byteSize`、`createdAt` | 是 | 都是既有 task/run 专属的可审查 metadata。 |
| `taskFileId`、`deliveryId` | 仅作为 React key/内部回调标识 | 不向可视文本暴露。 |
| `sha256`、`artifactLedgerId`、`taskId`、`runId` | 否 | 不增加不必要的可关联标识暴露。 |
| 文件 preview/diff 内容、ZIP 字节、Provider 输出、API key、endpoint | 否 | 仍只可通过既有受控 Inspector 或进程内 Provider 视图按需访问。 |

## 4. 组件边界

| 文件 | 职责 |
| --- | --- |
| `task-outcome-projection.ts` | 纯 metadata 投影、排序、限制与安全大小格式化；可离线单元测试。 |
| `TaskOutcomeBoard.tsx` | 原创块式显示与可访问按钮；不持有 Gateway client。 |
| `App.tsx` | 将既有 task/run DTO 和显式交付 intent 注入 Board；仅这里处理本地 Gateway 错误与按钮 pending 状态。 |
| `workbench.css` | 增加同一主题 token 下的成果块视觉层级，不引入第三方样式。 |

## 5. 验收标准

只有 task/run 工作台显示成果块；无任务聊天首页和 Settings 页面不显示该块。最多显示三项 metadata，且不显示敏感或运行细节。单击「审查成果」只聚焦 `#task-inspector`。单击「创建 ZIP 交付包」需要已有 task/run 文件，显示 pending，使用既有 `createDelivery` 调用，并且从不自动下载/执行。投影测试、类型检查、全套安全质量门和 Windows 来源证明全部通过。

## References

[1]: https://github.com/toeverything/AFFiNE "AFFiNE 官方仓库与块式工作区说明"
[2]: https://github.com/lobehub/lobehub "LobeHub 官方仓库与 Agent/Workspace 说明"
[3]: ../research/p21-affine-lobehub-task-outcomes-research.md "P21 许可证与来源调研"
