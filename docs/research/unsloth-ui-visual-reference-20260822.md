# Unsloth Studio 首页视觉参考边界

本轮仅将 Unsloth Studio 的公开界面作为 **AI Work OS 桌面首页视觉参考**。已核对的可借鉴视觉元素包括：薄荷绿色桌面背景、具有大圆角与柔和阴影的白色应用窗口、克制的 macOS 三色窗口控制、轻量侧栏、居中主画布与高度集中的输入操作区域。

参考来源：<https://github.com/unslothai/unsloth>

本轮不复制或导入 Unsloth 源代码、Studio 组件、图标、角色、商标或产品逻辑；AI Work OS 继续使用自身现有 React、CSS、Tauri、直接 Provider 与会话代码。用户明确要求不新增功能，因此 API 连接、模型选择、会话恢复、直接 SSE 流式输出和现有事件绑定全部维持。

Unsloth 根许可证说明：`unsloth/*`、`tests/*`、`scripts/*` 为 Apache-2.0；可选的 `studio/*` 与 `unsloth_cli/*` 为 AGPLv3。由于本轮只使用视觉理念并且不复用其代码，本仓库的原创 UI 改造不包含该项目的受许可证代码；此文件保留来源与版权边界说明。[Unsloth LICENSE](https://github.com/unslothai/unsloth/blob/main/LICENSE)

视觉复核记录：已在本地 Workbench 预览中核验，新首页保留原有侧栏、模型连接入口、角色切换、会话输入、附件入口与发送操作；首屏已改为薄荷色桌面背景、白色圆角工作窗口和居中欢迎区。为贴近参考图的单焦点首页，角色与状态区域改为紧凑信息带，不改变其现有按钮、选择或事件绑定。
