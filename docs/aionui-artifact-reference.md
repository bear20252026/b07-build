# AionUi 文件产物职责参考记录

本记录用于说明 NOVA 右侧“项目产物与历史”交互的来源与边界。实现采用 **原创的 TypeScript、React 与 Rust 代码**；未复制 AionUi 的源文件、UI 资产、Agent 运行时、CLI 集成或工作区权限代码。

| 项目 | 固定来源 | 许可证 | 本次借鉴的职责 | 未采纳内容 |
| --- | --- | --- | --- | --- |
| AionUi Preview 模块 | [`8c671bb40c2d415af76beb34c3d23d2f5ea20f05`](https://github.com/iOfficeAI/AionUi/tree/8c671bb40c2d415af76beb34c3d23d2f5ea20f05) | [Apache-2.0](https://github.com/iOfficeAI/AionUi/blob/8c671bb40c2d415af76beb34c3d23d2f5ea20f05/LICENSE) | 将文件身份、可展开树、按需预览和分栏尺寸状态视为独立职责。 | Agent 对工作区的读写、自动刷新、编辑器、多标签、CLI 与任何高权限文件模型。 |

> 本项目的普通聊天继续使用 WebView → Tauri invoke/events → Rust HTTPS/SSE → 用户选择的第三方 Provider 的原生直连。右侧产物树只消费已有回执 metadata，既不会扫描磁盘，也不会把文件正文自动送入 Provider。

本次新增的 Markdown 导出是一个明确用户动作：仅当用户已保存某一 assistant 回复，并在右侧预览中点击“导出 MD”后，原生层才显示单文件 Save As 对话框。WebView 不接收目标绝对路径，命令仅复制这一个已确认的 `.md` 文件；取消时不写入，且没有批量、脚本、自动导出或通用目录访问能力。

由于没有复制或分发上游代码，本次改动不引入 AionUi 的代码文件或其 NOTICE 内容。若未来实质性复制任何 AionUi Apache-2.0 源码，将在合并前把准确的上游路径、固定提交、许可证文本、必要归因及本地修改说明加入 `THIRD_PARTY_NOTICES.md`。

## 参考资料

1. [AionUi Preview 模块 README（固定提交）](https://github.com/iOfficeAI/AionUi/blob/8c671bb40c2d415af76beb34c3d23d2f5ea20f05/packages/desktop/src/renderer/pages/conversation/Preview/README.en.md)
2. [AionUi Apache License 2.0（固定提交）](https://github.com/iOfficeAI/AionUi/blob/8c671bb40c2d415af76beb34c3d23d2f5ea20f05/LICENSE)
3. [Tauri Dialog 官方文档](https://v2.tauri.app/plugin/dialog/)
