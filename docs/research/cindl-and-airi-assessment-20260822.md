# CINDL 对话记录与 AIRI VRM 角色评估

**日期：** 2026-08-22

## CINDL 名称核验

用户已更正技术名称为 **CINDL 聊天记录存储**。本轮以 `CINDL AI chat history storage`、`CINDL conversation history LLM` 和 `CINDL GitHub chat storage` 检索，仍未发现可核验的官方仓库、论文、规范、维护方或许可证。因此不能在没有准确链接的情况下将 CINDL 声称为已采用技术，也不应把未知实现直接接入对话历史持久化。

本项目会预留 `ConversationHistoryStore` 适配端口。后续若获得 CINDL 的准确来源，将审查其数据模型、迁移方式、离线能力、删除/导出能力、跨端同步模型、加密策略、许可证和依赖供应链，再决定是否实现 CINDL adapter。当前默认实现仍应使用本地、可审查的消息与 TEXT 工作块账本，且 API key、完整 Provider endpoint、cookie、浏览器秘密和未经确认的敏感输入不进入该账本。

## AIRI 的可借鉴范围

AIRI 官方仓库为 MIT 许可，版权声明为 `Copyright (c) 2024-PRESENT Neko Ayaka`；若复制其任何实质代码，必须在目标文件头、`THIRD_PARTY_NOTICES.md` 和随附许可中保留该声明与完整 MIT 文本。[1] [2]

其公开资料显示，它包含 Live2D 和 VRM 模型能力，VRM 有自动眨眼、注视和待机动画；并分别拥有网页、桌面和移动运行形态。[1] [3] 这些是可借鉴的**视觉运行时分层原则**，而不是将 AIRI 的完整 Vue/Electron/Capacitor/Node monorepo原样嵌入当前 React/Tauri/Rust/TypeScript 工作区的理由。

| AIRI 能力 | AI Work OS 采用方式 | 明确不采用的行为 |
| --- | --- | --- |
| VRM 展示、眨眼、注视、待机状态 | 建立可替换的 3D companion renderer，作为前端视觉插件；与现有 2D Orbit/Mori/Pixel/Sage 并存。 | 不让角色模型、动画或 UI 直接调用 Gateway、数据库、系统控制或浏览器控制。 |
| 浏览器本地数据库/持久记忆 | 借鉴可移植 adapter 思路；保持本项目 SQLite 账本和用户可控 TEXT 工作块。 | 不引入自动记忆提取、未确认跨会话画像或第三方同步。 |
| Web / desktop / mobile 舞台分离 | 保持共享 UI 契约与平台 adapter；预留网页入口。 | 不迁移到 Electron、Vue 或 Capacitor，也不以桌宠需求替换当前 Windows-first Tauri 壳。 |
| 音频、屏幕、游戏与 MCP 集成 | 记录为独立后续能力，必须逐项经过授权、隐私和平台评审。 | 不随 3D 角色入口启用麦克风、屏幕捕获、系统自动化、游戏控制或后台服务。 |

## 最小安全起点

第一阶段只实现：角色类型选择（现有 2D 与新增 3D 占位）、视觉状态投影、无资产时的明确回退、减少动态效果支持，以及与文本会话 UI 的本地状态绑定。它不加载第三方 VRM 文件、不请求摄像头/麦克风、不创建悬浮置顶窗口，也不授予任何 Agent 执行能力。

## References

[1] [Project AIRI README](https://github.com/moeru-ai/airi)

[2] [Project AIRI MIT License](https://github.com/moeru-ai/airi/blob/main/LICENSE)

[3] [AIRI documentation — Introduction](https://airi.moeru.ai/docs/en/docs/overview/)

## Workbench 真实页面验证

已在本地浏览器验证“设置 → 扩展与能力 → Companion Agent”链路。二级摘要卡显示“视觉已启用 / 3D / VRM 舞台 / 语音默认关闭 / 高影响能力全部关闭”；三级页显示默认开启的角色视觉开关、2D/3D 渲染模式、独立 TTS 与主动语音开关，以及麦克风、屏幕捕获、桌面自动化、游戏控制和后台服务的明确关闭状态。该控制面保持在独立设置浮层，极简首页未加入复杂控制。

## AIRI 设置与资源架构补充审查

只读稀疏审查显示，AIRI 的舞台设置按场景、模型引擎与角色参数拆分，包含 Live2D 参数、VRM/MMD 视线、动作、物理、表达与缓存清理等分区。这适合作为 AI Work OS 的“服务来源 / 机体模块 / 角色模型 / 角色卡 / 系统”分层信息架构参考，但其 Vue 组件、Electron/Capacitor 运行时、依赖图及完整资源包不应直接并入现有 React/Tauri 工作台。后续仅可选择 MIT 许可覆盖、运行时可隔离且版权可归因的特定资源或算法模块，并应采用按需加载以控制桌面包体。

## Companion Studio 浏览器验证

已在本地 Workbench 验证“设置 → 扩展与能力”中的 AIRI-style Companion Studio 摘要。摘要显示服务来源 4/4、机体模块 9/9、Live2D/VRM 模型插槽、当前角色卡和 Windows 常驻规划入口；所有入口均位于独立设置浮层。聊天首页未增加服务来源、游戏、Discord、模型导入或后台控制内容。

## AIRI 角色资产审查结论

在只读 AIRI 参考树中未发现 `.vrm`、`.moc3`、`.model3.json` 或 `.glb` 可作为项目默认角色资源直接再分发的文件。因此本轮不会把“空资源引用”伪装为已导入 3D 角色，也不会从未知镜像下载模型。AIRI 的 MIT 许可证覆盖仓库代码，但单独的模型、纹理、动作或角色形象仍必须逐项核验来源与再分发条件。当前 Workbench 保留 VRM/Live2D 插槽与按需加载边界；后续只能导入来源、许可证、体积与安全扫描均明确的本地模型资产。

## 云端浏览器布局与角色呈现复核

本轮通过云端浏览器依次打开首页、独立设置浮层、扩展与能力页和 Companion Agent 三级页。首页左侧仍显示四个已有 2D 动态角色（Orbit、Mori、Pixel、Sage）；Companion 页面默认选择“3D / VRM 舞台”，但页面明确说明尚未捆绑或导入经过审查的 VRM 模型文件。因而当前可见的真实角色资产仍为 2D 动态玩偶，尚不存在可向用户展示的真实 VRM 3D 人物渲染。语音开关为默认关闭，且高影响能力仍显示为关闭。
