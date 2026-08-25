# NOVA 视觉参考与署名记录

## 本次参考范围

NOVA 的开屏视觉参考了用户明确授权使用的公开 UI 资料，并采用原创 React/CSS 实现，不复制 Vue 单文件组件、依赖图或组件代码。

| 上游资料 | 上游与许可 | NOVA 的使用方式 | 未采用内容 |
| --- | --- | --- | --- |
| Inspira UI：Lamp Effect、Aurora Background、Breathing Text | `unovue/inspira-ui`，MIT，Copyright (c) 2024–2026 rahulv.dev。 | 参考“短时光效、呼吸节奏与品牌聚焦”的视觉职责；以 CSS keyframes 原创实现双弧错位旋转、中心点呼吸和低强度蓝紫光晕。 | 未复制 Vue SFC、未安装 `motion-v`、未导入源码。 |
| Inspira UI：Liquid Background、Neural Background、Wavy Background | 同上；注册表分别声明 `ogl`、`ogl`、`simplex-noise` 依赖。 | 仅在方案比较中评估。 | 不在桌面启动路径引入 WebGL 或噪声依赖，避免增加冷启动、GPU、内存与 reduced-motion 风险。 |
| 用户提供的圆环 NOVA 图标 | 用户直接提供并明确要求作为品牌图标。 | 只进行格式转换以适配 Tauri PNG/ICO 和 Workbench 资源；不重绘、不改变图案语义。 | 不作为 Provider 请求、模型上下文或网络上传内容。 |

## 实现修改说明

NOVA 将使用一段有界、可跳过、尊重 `prefers-reduced-motion` 的启动视觉：最大约 1.35 秒，或在应用就绪后尽早结束。它只覆盖 WebView 的初始可见区域，不等待、不改变、不代理普通聊天的 Tauri → Rust HTTPS/SSE → 用户选定第三方 Provider 直连。

## 资料链接

- Inspira UI repository and MIT license: <https://github.com/unovue/inspira-ui/blob/main/LICENSE>
- Inspira registry: <https://registry.inspira-ui.com/lamp-effect.json>、<https://registry.inspira-ui.com/aurora-background.json>、<https://registry.inspira-ui.com/breathing-text.json>
- DeepSeek V4 Flash official API docs: <https://api-docs.deepseek.com/>
