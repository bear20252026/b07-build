# P17：多 Provider 与自定义兼容 API 接入调研

**日期：** 2026-08-21

## 1. 官方 Provider 契约

| Provider | OpenAI-compatible 基址 / 路径 | Anthropic-compatible 基址 / 路径 | 默认模型 | 官方事实 |
|---|---|---|---|---|
| Xiaomi MiMo | `https://api.xiaomimimo.com/v1` → `/chat/completions` | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.5-pro` | MiMo 明确兼容 OpenAI 和 Anthropic 两种主流格式；按量 API key 使用 `sk-`，Token Plan 使用独立基址和 `tp-` key。[1] |
| LongCat（美团龙猫） | `https://api.longcat.chat/openai` → `/v1/chat/completions` | `https://api.longcat.chat/anthropic` → `/v1/messages` | `LongCat-2.0` | 官方同时提供 OpenAI / Anthropic 格式，使用 Bearer Token；模型上下文 1M、最大输出 128K。[2] [3] |
| Kimi（Moonshot） | `https://api.moonshot.cn` → `/v1/chat/completions` | 未作为 P17 内置预设 | `kimi-k3` | Kimi 官方支持 OpenAI Chat Completions、Bearer key、SSE，推荐默认使用 `kimi-k3`，并声明 1M 上下文。[4] [5] |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` → `/chat/completions` | 未作为 P17 内置预设 | `glm-5.3` | 智谱官方文档给出 OpenAI SDK 基址和 `glm-5.3` 示例；支持流式响应与 thinking 扩展。[6] |

本项目的通用 OpenAI adapter 默认在基址后添加 `/v1/chat/completions`。因此 MiMo、Kimi 和智谱的预设基址直接携带 `/v1`（或等价版本前缀）；LongCat 的预设基址为 `/openai`，其默认路径恰好得到官方 `/openai/v1/chat/completions`。DeepSeek 是例外：官方基址不含 `/v1`，必须采用此前 P16 引入的 `/chat/completions` 变体。

## 2. 自定义兼容 Provider 的安全模型

用户需要连接符合 OpenAI / Anthropic 格式的自有模型。浏览器每次请求都允许任意 URL 会把本机 Gateway 变成可被诱导的 SSRF 代理，因此 P17 采用“**显式登记的会话 Provider**”而非“每次调用可自由填写 URL”。

| 项目 | P17 约束 |
|---|---|
| 用户输入 | 显示名称、协议、HTTPS base URL、模型名、API key；浏览器不能输入 driver id、请求路径、header、tool 列表或任意请求 body。 |
| URL 检查 | 必须是绝对 HTTPS URL；禁止 username/password、query、fragment、IP literal、loopback、link-local、私网、`localhost` 与非 443 显式端口。URL 只允许路径根或兼容协议所需的版本前缀，不能包含 `/chat/completions` 或 `/messages` 的完整操作路径。 |
| 注册模型 | 通过唯一 session id 生成 `custom.<opaque-id>` Provider metadata；base URL、模型、协议和 credential 仅驻留当前 Gateway 进程内存，不写入 SQLite/Profile/任务事件或 WebView DTO 以外的最小状态摘要。 |
| 调用 | 用户必须先显式保存并启用；Gateway 由保存时的 immutable metadata 组装 HTTPS 调用。调用结果沿用输入长度、SSE chunk、输出长度和 DTO 脱敏限制。 |
| 自有本地模型 | 私网/loopback 自托管模型不走 custom remote Provider；继续使用已有的受控本地模型端点管理路线，避免把本地端口暴露给浏览器任意转发。 |
| 工具和思考 | 支持协议 transport 与流式文本，不直接启用模型 tool calls、raw reasoning 或自定义 header；模型提出的工具仍必须经既有能力/审批链。 |

## 3. 产品路径

模型连接页保留显式 Provider 预设为快捷安全路径，同时新增“自定义兼容 API”。用户先选择 OpenAI-compatible 或 Anthropic-compatible，再输入 Base URL 和模型名。该配置在页面上明确标示为“远程数据会按你的提示发送到此服务”；连接后的列表显示**协议、模型、会话状态和受控连接标记**，不显示 base URL、key、header 或探测响应正文。

## References

[1]: https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call "Xiaomi MiMo API: first API call"
[2]: https://longcat.chat/platform/docs/zh/ "LongCat API: quick start"
[3]: https://longcat.chat/platform/docs/zh/api-docs "LongCat API: overview"
[4]: https://platform.kimi.com/docs/overview "Kimi API: quick start"
[5]: https://platform.kimi.com/docs/api/overview "Kimi API: overview"
[6]: https://docs.bigmodel.cn/cn/guide/develop/openai/introduction "Zhipu AI: OpenAI compatibility"
