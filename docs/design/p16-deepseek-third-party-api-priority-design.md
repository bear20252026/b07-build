# P16：DeepSeek 第三方 API 优先接入设计

**状态：** 已设计，待实现

## 1. 真实调用闭环

P16 的目标不是模拟 API，也不是将远程模型替换为本地模型。用户在 Windows Workbench 的“模型连接”页选择 DeepSeek、输入 API key、点击“保存并启用连接”后，Gateway 在**当前进程内存**保存 key，登记并启用 `provider.deepseek`。用户随后在“已连接模型”的显式受限文本试用区点击发送，Gateway 的 `ProviderInferenceService` 使用已审核 `remote.deepseek` driver 访问 DeepSeek 官方 `https://api.deepseek.com/chat/completions`，以 SSE 读取文本 delta、实施字数与 chunk 预算，再把脱敏聚合结果回传 Workbench。

| 层 | P16 责任 | 明确不允许 |
|---|---|---|
| Provider catalog | 提供审查过的 DeepSeek 基址、官方稳定模型别名、能力 metadata 和公开文档 URL | 浏览器/配置表单自定义 endpoint、driver 或 credential reference。 |
| OpenAI-compatible driver | DeepSeek 使用 `/chat/completions`、Bearer header、`stream: true`、SSE `data: [DONE]` 结束 | 将原始 SSE、authorization header 或 response body 透传到 UI。 |
| Provider inference service | 仅在已激活 Profile 和可用 session credential 后发起 HTTPS；对 chunk/输出施加上限 | 自动调用、工具自动执行、持久化 API key、回传 reasoning chain。 |
| Gateway route | 保留 `x-awo-operator-intent`，接受 `prompt` 和已审核 model override | 接受 apiKey、endpoint、headers、tools 或任意 JSON。 |
| Workbench | 第三方 API 设置和一次显式文本试用；显示脱敏结果和错误归一化 | 直连 `api.deepseek.com`、存储 key、静默请求或隐式代理。 |

## 2. 官方契约映射

| 官方项 | P16 实现 |
|---|---|
| `https://api.deepseek.com/chat/completions` | `OpenAICompatible` 为 `deepseek` 采用 `/chat/completions`，不错误地附加 `/v1`。 |
| `Authorization: Bearer` | 仅在 Gateway driver request header 组装；客户端 DTO 始终为 `canReadSecret: false`。 |
| `deepseek-v4-flash` / `deepseek-v4-pro` | 将 DeepSeek 目录 default 保持 `deepseek-v4-pro`，并把 context capability 更新为官方 1M。 |
| `stream: true` + `[DONE]` | 复用已有限流异步聚合；测试 DeepSeek URL、header、model、输入不泄密和 DONE 文本组合。 |
| `thinking` / tool calls | 保持 Provider 默认；不向用户试用接口公开 raw reasoning 或 tools。未来任务编排只可把模型提议映射到既有 capability/approval 链。 |

## 3. 失败语义

没有 API key、未激活 Profile、非允许 Provider、HTTP 失败、SSE 无正文、超时、超过安全 chunk/文本限制时，Driver 或 inference service 返回规范化失败；不会回退到另一家服务、不会自动探测或重试、不会生成或执行任务工具。测试使用拦截的 `fetch` 模拟 DeepSeek；在用户没有提供其 API key 时不访问真实付费接口。

## 4. 验收

验收须证明 DeepSeek 请求精确命中官方 `/chat/completions`，携带 Bearer key 和官方模型别名，SSE 文本能安全聚合；返回 DTO 不含 key/base URL/headers；缺少显式 activation 不会发出请求；原有 Provider 与 Windows 桌面安全契约无回归。

## References

[1]: https://api-docs.deepseek.com/zh-cn/ "DeepSeek API docs: first API call"
[2]: https://api-docs.deepseek.com/zh-cn/api/create-chat-completion "DeepSeek API docs: Chat Completions API"

### 浏览器级连接向导验证

本地 Workbench 已实际显示 `AI WORK OS · THIRD-PARTY API`。模型连接页默认选中 DeepSeek，显示名称预填“我的 DeepSeek”，模型字段预填 `deepseek-v4-pro`，且 DeepSeek 描述为官方 OpenAI-compatible Chat Completions API。页面仍要求用户先显式附着 Gateway，再输入自己的 API key；未输入 key 或未点击保存不会调用远程 API。

### 最终验证

P16 的 DeepSeek Gateway HTTP 契约测试通过，证明显式会话配置后请求精确命中 `https://api.deepseek.com/chat/completions`，携带仅会话内存可见的 Bearer credential，SSE 文本按 `data: [DONE]` 结束并聚合为脱敏结果；reasoning-only delta 未回传。缺少 API key 或显式配置不会触发真实付费请求。

全量质量门通过：架构检查、严格 TypeScript、220/220 测试、Workbench 生产构建、Rust process supervisor 11/11、Windows helper 2/2、Python sidecar 编译、Gateway sidecar 打包、生产依赖审计 0 vulnerabilities、桌面壳 CSP/sidecar 契约 7/7。Workbench 生产 bundle 未引入新的远程运行时依赖。
