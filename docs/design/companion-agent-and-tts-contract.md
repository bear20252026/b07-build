# Companion Agent 与受控 TTS 契约

**日期：** 2026-08-22

## 目标与默认状态

Companion Agent 是一个与任务执行 Agent 分离的本地视觉/交互能力。其 3D 视觉状态默认开启，用户可在“设置 → 扩展与能力 → Companion Agent”三级页完全关闭。关闭视觉角色不得影响任务、项目、Provider、交付、审计或设置功能。

现有 Orbit、Mori、Pixel、Sage 2D 动态玩偶保持不变。3D/VRM 是另一种可选择的渲染模式，而不是替换已有角色或授予任何执行能力。

## 权限矩阵

| 能力 | 默认状态 | 启用条件 | 本轮实现状态 |
| --- | --- | --- | --- |
| 2D / 3D 视觉呈现 | 3D 偏好默认启用 | 可在三级页面完全关闭或切换为 2D | 本机无秘密偏好与 UI 控制已实现；未加载外部 VRM 资产。 |
| 第三方 TTS 输出 | 关闭 | 用户在三级页显式启用，并完成受限 Provider 配置和一次明确播放动作 | 仅定义契约；不自动连接、调用或播放。 |
| 主动语音提示 | 关闭 | 先启用 TTS，再单独开启；仅限未来可见的规则触发 | 仅定义开关；不启动后台服务。 |
| 麦克风 / ASR | 关闭 | 未来单独请求平台权限和用户确认 | 未实现。 |
| 屏幕捕获 | 关闭 | 未来单独请求平台权限和用户确认 | 未实现。 |
| 桌面自动化 / 浏览器 / 游戏控制 | 关闭 | 独立能力、显式审批、可审计授权与平台适配 | 未实现。 |
| 后台常驻服务 | 关闭 | 独立产品设置与平台生命周期评审 | 未实现。 |

任何角色渲染状态、TTS Provider 状态或主动说话偏好均不得隐式继承文件写入、模型工具、浏览器、桌面控制或管理员租约。API key、完整 endpoint、语音样本、音频内容、屏幕内容和聊天正文不得进入 Companion 偏好本地存储。

## MiMo V2.5 TTS 适配结论

小米官方文档确认 `mimo-v2.5-tts` 支持预置音色、WAV 输出和低延迟流式 PCM16 输出；接口使用 OpenAI Chat Completions 兼容地址 `https://api.xiaomimimo.com/v1/chat/completions`，认证支持 `api-key` 或 Bearer 形式。[1] [2]

受控适配器必须满足以下条件：只从当前 Gateway 会话读取临时凭据；TTS 文本由用户明确输入或明确选中，不得把完整聊天历史、隐藏推理、系统提示、网页内容或秘密自动送出；返回的音频只作为一次性内存播放数据或由用户明确保存的任务产物；Provider、模型、音色与播放动作必须形成脱敏审计收据。音色复刻因涉及用户语音样本，需另设独立的同意、上传、保留期限和删除机制，本轮不实现。

## AIRI 参考边界

AIRI 在 MIT 许可下提供 3D VRM / Live2D 状态、自动眨眼、注视与待机动画等参考模式。[3] 本项目仅将其作为可隔离的视觉运行时研究输入。任何实质复制必须保留 `Copyright (c) 2024-PRESENT Neko Ayaka` 和完整 MIT 许可；当前 React/Tauri 工作台不直接嵌入 AIRI 的 Vue/Electron/Capacitor monorepo，也不因导入角色能力启用其屏幕、游戏、语音或 MCP 功能。

## 跨平台接口

偏好结构和 UI 事件是平台中立的。Windows Tauri、未来 Android/iPad/macOS 壳和网页端可共享同一个 `CompanionPreferencesV1` 契约；仅 Renderer、音频输出、系统权限与安全存储实现为平台 adapter。网页端不得尝试启动本机 Gateway sidecar；桌面端不得假定移动端可以绑定 loopback 服务或运行后台进程。

## References

[1] [MiMo V2.5 TTS — Speech synthesis](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)

[2] [MiMo — OpenAI Chat Completions compatibility](https://mimo.mi.com/docs/en-US/api/chat/openai-api)

[3] [Project AIRI README](https://github.com/moeru-ai/airi)
