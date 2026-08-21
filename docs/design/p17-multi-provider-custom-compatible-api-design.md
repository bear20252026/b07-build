# P17：多 Provider 预设与受控自定义兼容 API 设计

**状态：** 已设计，待实现

## 1. 范围

P17 增加 Xiaomi MiMo、LongCat（美团龙猫）、Kimi 和智谱 GLM 四个经过官方文档核验的静态第三方 Provider 预设。它们与既有 DeepSeek、OpenAI、Anthropic、Gemini、Mistral、OpenRouter 一样，只由 Gateway 内的固定 driver 调用。

P17 同时提供用户的 OpenAI-compatible / Anthropic-compatible 自有模型接入，但不让 WebView 将 Gateway 当作任意网络转发器。自定义 Provider 是用户一次显式保存后生成的**进程内 session 连接**，不是持久化配置、不是浏览器自由 URL 请求、更不是远程服务端账户。

## 2. 静态目录

| ID | 协议 | base URL | 默认模型 | 特殊路径 |
|---|---|---|---|---|
| `mimo` | OpenAI Chat Completions | `https://api.xiaomimimo.com/v1` | `mimo-v2.5-pro` | 默认 `/v1/chat/completions`。 |
| `longcat` | OpenAI Chat Completions | `https://api.longcat.chat/openai` | `LongCat-2.0` | 默认 `/v1/chat/completions`，得到官方 `/openai/v1/chat/completions`。 |
| `kimi` | OpenAI Chat Completions | `https://api.moonshot.cn` | `kimi-k3` | 默认 `/v1/chat/completions`。 |
| `zhipu` | OpenAI Chat Completions | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3` | 使用 `/chat/completions` 变体，得到官方 `/api/paas/v4/chat/completions`。 |

MiMo 与 LongCat 也兼容 Anthropic，但第一版使用已存在的 OpenAI adapter 作为内置默认路径；用户仍可通过 custom Anthropic-compatible 表单连接其确定的 Anthropic 兼容部署。模型 tool call 与 raw reasoning 不因预设注册而自动执行或回显。

## 3. Custom session Provider

新增 `SessionCustomProviderService`，归属 `provider-sdk`。它拥有内存中的 immutable endpoint metadata 和 session credential reference，关闭 Gateway 即消失。它不能写 SQLite、读取环境变量、列出 key 或将 base URL 映射回 Workbench DTO。

```text
Workbench custom form
  └─ POST 127.0.0.1:4318/api/providers/connections/custom/configure-session
       └─ Gateway route validates a strict body + explicit operator intent
            └─ SessionCustomProviderService validates destination and stores only in memory
                 └─ OpenAICompatible or AnthropicMessages driver on explicit probe/infer
                      └─ redacted ProviderConnectionStatus / ProviderInferenceResult
```

| 输入字段 | 允许值 | 不允许 |
|---|---|---|
| `displayName` | 1–80 个可显示字符 | 为空、持久化中泄漏 key。 |
| `protocol` | `openai-compatible` / `anthropic-compatible` | 自定义 driver / protocol discriminator。 |
| `baseUrl` | 绝对 HTTPS，域名主机，标准 443 端口，根路径或版本前缀 | HTTP、IP literal、localhost、私网/链路本地 host、userinfo、query、fragment、完整操作路径。 |
| `model` | 受现有安全模型标识正则限制 | 工具、header、请求 body 或 prompt。 |
| `apiKey` | 仅 explicit session write，长度/控制字符校验 | SQLite、task event、Profile、DTO、日志或接口回显。 |

端点验证的目的不是绕过用户选择的远程自有模型，而是拒绝明显的浏览器到内网/本机转发。需要调用本机或私网模型时，用户应继续使用已有 Local Model Endpoint 的受控注册路径，不通过远程 custom Provider。

## 4. 路由与 DTO

| HTTP API | 语义 |
|---|---|
| `GET /api/providers/connections` | 合并静态预设和本进程 custom 连接的脱敏 status，不带 base URL 或 key。 |
| `POST /api/providers/connections/custom/configure-session` | 只接受完整 custom 配置和 operator intent，返回新 `custom-…` status。 |
| `POST /api/providers/connections/custom-…/probe` | 仅已保存连接、显式 intent；对固定 session base URL 探测。 |
| `POST /api/providers/connections/custom-…/infer` | 仅已保存连接、显式 intent；受现有输入、SSE、输出预算限制。 |

Browser DTO 对 `credentialReference` 增加只读 `session.custom-*` 引用名兼容，但仍拒绝 endpoint、header、API key、tool、可自动连接/执行字段。

## 5. Workbench

模型连接页将 DeepSeek、MiMo、LongCat、Kimi、智谱与现有 Provider 一同显示。`自定义兼容 API` 使用用户已选协议，显示额外 HTTPS Base URL 字段和远程数据提示。保存后会进入“已连接模型”，可进行一次明确 probe 或受限文本试用；任何请求均不自动发生。

## 6. 验收

P17 需覆盖各预设 URL 与模型目录、custom OpenAI/Anthropic driver 选择、合法 HTTPS 域名、localhost/IP/HTTP/完整路径拒绝、key/base URL 不回显、Gateway 重启后 custom 会话丢失、缺 key 不联网和既有 Provider 回归。

## References

[1]: https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call "Xiaomi MiMo API: first API call"
[2]: https://longcat.chat/platform/docs/zh/ "LongCat API: quick start"
[3]: https://platform.kimi.com/docs/overview "Kimi API: quick start"
[4]: https://docs.bigmodel.cn/cn/guide/develop/openai/introduction "Zhipu AI: OpenAI compatibility"

## 浏览器级验证

本地 Workbench 的模型连接页已真实显示 DeepSeek、Xiaomi MiMo、LongCat（美团龙猫）、Moonshot Kimi、智谱 GLM 及既有 Provider。点击“自定义兼容 API”后，向导切换为四字段表单：显示名称、HTTPS Base URL、模型名与 API key；页面明确提示不填写完整操作路径或 header，并说明保存前不会请求远程服务。该切换仅改变 UI 局部状态，未附着 Gateway、未提交凭据、未发起第三方请求。

## 最终验证

P17 新增 custom Provider 领域测试覆盖 OpenAI-compatible 与 Anthropic-compatible transport、SSE 聚合、endpoint/API key 不回显、非 HTTPS/IP/localhost/`.local`/userinfo/完整操作路径拒绝及新 Gateway session 后自动失效。Gateway HTTP 契约测试覆盖 custom 配置的精确 body 白名单、operator intent、脱敏列表和固定 session endpoint 推理。

全量质量门通过：架构检查、严格 TypeScript、225/225 测试、Workbench 生产构建、Rust process supervisor 11/11、Windows helper 2/2、Python sidecar 编译、Gateway sidecar 打包、生产依赖审计 0 vulnerabilities、桌面壳 CSP/sidecar 契约 7/7。P17 未放宽 CSP，未引入浏览器到 Provider 的直连、服务端持久化或自动远程调用。
