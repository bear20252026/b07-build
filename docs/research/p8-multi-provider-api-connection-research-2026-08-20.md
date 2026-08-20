# P8 多供应商模型 API 连接调研

**日期：** 2026-08-20  
**范围：** 为 AI Work OS 的本地 Gateway 设计用户显式授权、凭据不进入 Workbench 或配置账本、可适配主流商业与 OpenAI-compatible 模型 API 的连接层。

## 结论

本阶段不应让 Workbench 直接访问供应商，也不应把 API 密钥写进 SQLite、Provider Profile 或前端状态。应维持现有 `ModelDriver` 端口与 `ProviderProfile` 元数据账本，再新增一个位于 Gateway composition root 的凭据解析端口和连接诊断端口。Workbench 只能读取经脱敏的连接状态，并在用户明确点击后向 loopback Gateway 提交“创建 / 更新 / 激活 profile”的受审计意图；它不能提交密钥、直接探测供应商、自动启动 Gateway 或扩大数据边界。

## 官方契约事实

| 类别 | 官方契约 | 对 AI Work OS 的设计含义 |
|---|---|---|
| OpenAI | API key 使用 Bearer 身份验证；官方明确要求不得在浏览器或客户端代码暴露密钥。新项目推荐 Responses API，同时 Chat Completions 仍受支持。 | 保留 Chat Completions 作为兼容底座；为 Responses 增设独立 driver，不能将两者混用为同一隐式行为。所有密钥仅在 Gateway 执行进程解析。 |
| Anthropic | 原生 REST API 为 `POST /v1/messages`，需要 `x-api-key` 或 Bearer token、`anthropic-version` 与 JSON content type；支持 SSE 流。 | 保留独立的 `AnthropicMessages` driver，不把它强行伪装为 OpenAI；错误、请求 ID 和流式事件需要规范化为内部结果。 |
| Gemini | 官方提供 OpenAI-compatible Chat Completions 入口，并需要变更 base URL、模型标识和 API key；也推荐原生 API 以使用全部新能力。 | Gemini 可先作为 OpenAI-compatible Profile Catalog 条目快速接入；后续可增加原生 Gemini adapter，而不改变 Profile 语义。 |
| DeepSeek | 官方明示 OpenAI/Anthropic 格式兼容；OpenAI 格式 base URL 为 `https://api.deepseek.com`，兼容 stream 参数。 | 可作为 OpenAI-compatible Catalog 条目，以 base URL、模型 allowlist 和 credential reference 的显式组合实现。 |
| Mistral | Chat Completion API 接收带角色的 messages，并支持流式、多轮、工具和结构化输出等能力。 | 初期复用 OpenAI-compatible adapter 的核心文本流能力，但不宣称未实现的 provider-native 功能；高级工具能力由显式 capability metadata 驱动。 |

## 参考项目架构吸收

OpenClaw 的核心可借鉴点是将 provider/model 引用、模型能力、默认与 fallback、连接 probe、认证来源状态分开处理。AI Work OS 采纳“配置 / 模型目录 / 传输 adapter / 凭据来源 / 路由决策”五层分离，但不采纳密钥轮换、自动 failover 或 UI 直接保存 API key 的默认行为。LobeHub、Cherry Studio、Chatbox 等项目提供用户友好的供应商卡片和模型配置体验；AI Work OS 应将这种体验限制在仅显示 profile、驱动、数据边界、凭据引用名、状态和受控诊断，而不是将真正密钥发送到 WebView。

## 初始支持矩阵

| Provider Profile 类型 | 初始驱动 | 凭据来源 | 连接方式 | 默认状态 |
|---|---|---|---|---|
| OpenAI | OpenAI-compatible Chat Completions | Gateway host 环境变量引用 | 直接 API | registered |
| Anthropic | Messages API | Gateway host 环境变量引用 | 原生 Messages API | registered |
| Gemini | OpenAI-compatible Chat Completions | Gateway host 环境变量引用 | Gemini compatibility API | registered |
| DeepSeek | OpenAI-compatible Chat Completions | Gateway host 环境变量引用 | DeepSeek compatibility API | registered |
| Mistral | OpenAI-compatible Chat Completions | Gateway host 环境变量引用 | Chat Completions-compatible route | registered |
| Custom compatible | OpenAI-compatible Chat Completions | Gateway host 环境变量引用 | 用户审核过的 HTTPS endpoint | registered |
| Local OpenAI-compatible | Local adapter | 无远程 credential | loopback endpoint | registered |

## 安全不变量

1. `credentialReference` 仅保存引用名；任何 profile JSON、HTTP DTO、任务事件和 Workbench state 均不得包含 API key、OAuth token 或授权 header。
2. Workbench 仅能访问 loopback Gateway；桌面 CSP 保持不含 `unsafe-eval`，也不得为供应商域名放宽 `connect-src`。
3. Provider Profile 的激活只允许用户显式调用；创建或更新 profile 不自动测试连接、不自动发起模型请求、不改变默认模型。
4. Gateway route 不读取 `process.env`。环境凭据解析只能在 composition root 装配的 dependency 后执行，且返回值不会被日志或错误文本回显。
5. 远程调用前，router 继续以 Profile allowlist 和 `maximumDataBoundary` 收紧请求；`local-only` 永远拒绝远程 driver。
6. 第三方工具调用、MCP、文件上传、远程会话持久化和自动密钥轮换均不属于本阶段；必须在未来由独立 capability 与审批路径实现。

## 来源

[1] OpenAI API Overview — https://developers.openai.com/api/reference/overview

[2] OpenAI: Migrate to the Responses API — https://developers.openai.com/api/docs/guides/migrate-to-responses

[3] Anthropic API Overview — https://platform.claude.com/docs/en/api/overview

[4] Google Gemini API: OpenAI compatibility — https://ai.google.dev/gemini-api/docs/openai

[5] DeepSeek API Docs — https://api-docs.deepseek.com/

[6] Mistral Chat Completions — https://docs.mistral.ai/studio-api/conversations/chat-completion

[7] OpenClaw Model Providers — https://docs.openclaw.ai/concepts/model-providers

[8] OpenClaw Authentication — https://docs.openclaw.ai/gateway/authentication
