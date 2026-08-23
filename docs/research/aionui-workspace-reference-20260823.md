# AionUi 工作区交互与复用边界调研

日期：2026-08-23

## 上游与许可证

- 上游仓库：<https://github.com/iOfficeAI/AionUi>
- 许可证：Apache License 2.0。
- 复用规则：复制或修改上游源文件时，保留原有版权、专利、商标和归属声明；附带 Apache-2.0 许可证副本；如上游包含适用 NOTICE，则在本项目第三方声明中保留可读副本；每个修改过的上游文件都必须显著标识修改。

## 可对照的交互目标

1. 三栏工作区：左栏承载会话/项目和底部设置；中央仅承载当前对话并独立滚动；右栏只在用户需要文件、变更或预览时出现，且可关闭。
2. 底部输入区保持可见，但不得捕获聊天时间线的滚轮、触控板或键盘滚动事件。
3. 文件与变更面板应当是独立检查器，不将历史聊天固定或挤压为不可滚动区域。
4. 多会话切换不销毁本地账本；流式回答仅更新当前消息，避免整页重渲染。
5. GitHub 代码协作应拆分为本地变更预览、明确提交、明确确认推送；个人访问令牌绝不进入聊天、Provider 上下文、日志、版本库或发布清单。

## 已审阅的上游实现

- `packages/desktop/src/renderer/components/layout/Layout.tsx`：Apache-2.0 头部位于源文件第 1-5 行。其核心结构是左侧 `Sider` 与 `[content | preview | project explorer]` 同级 flex 行；右侧预览/资源面板提升到路由内容树之外，使同项目会话切换时不被卸载。可借鉴其“右侧检查器作为中央聊天的同级列、而非遮罩层或聊天子元素”的结构。
- `packages/desktop/src/renderer/hooks/chat/useAutoScroll.ts`：Apache-2.0 头部位于源文件第 1-5 行。内容变化时只在用户距底部阈值以内才滚至底部，避免用户阅读历史时被流式更新强制拉回底部。AI Work OS 将采用同等行为，但会以现有 React/TypeScript 栈重写或在明确复制时保留完整文件头与 NOTICE。

## 明确不复用的范围

- AionUi 的 Electron 进程、CLI Agent 运行时、远程访问、定时任务和其模型/Gateway 实现不纳入当前直接 Provider 聊天链路。
- 本项目不使用 AionUi 商标、产品名、图标或界面中可识别的品牌资产。

## 当前项目的复用策略

本项目当前的第三方模型路径为 WebView → Tauri Rust → 第三方 HTTPS/SSE。AionUi 的 UI 结构、面板状态管理、会话/文件检查器交互可作为对照或在许可条件下引用；不得将不兼容的 Gateway、CLI Agent、远程访问或后台自动化代码混入直接 Provider 聊天链路。

## 后续所需证据

- 选定具体 AionUi 上游文件与 commit。
- 将源文件或提取模块复制到 `third_party/aionui/` 或带头部归属的项目文件。
- 更新 `THIRD_PARTY_NOTICES.md`，并在修改文件中注明来源、许可证与修改日期。
- 针对滚动、右侧检查器展开/收起和流式渲染建立回归测试。
