# P16：DeepSeek 第三方 API 真实接入契约调研

**日期：** 2026-08-21

## 1. 官方契约摘要

DeepSeek 官方文档将 OpenAI-compatible 基址列为 `https://api.deepseek.com`，对话端点为 `POST /chat/completions`，并以 `Authorization: Bearer <API key>` 鉴权。[1] 官方首页同时说明可通过 OpenAI/Anthropic SDK 或兼容软件访问；当前文档列出的稳定别名为 `deepseek-v4-flash` 与 `deepseek-v4-pro`，模型版本升级时保持别名调用方式不变。[1]

| 领域 | 官方契约 | AI Work OS 实现要求 |
|---|---|---|
| 请求路径 | `POST https://api.deepseek.com/chat/completions` | Gateway 内的固定 DeepSeek driver 组合该基址；WebView 不接收/输入任意 endpoint。 |
| 鉴权 | Bearer API key | 用户输入仅随显式“保存并启用”动作交给回环 Gateway；仅进程会话内存可读，不写入 SQLite/Profile/事件/DTO。 |
| 模型 | `deepseek-v4-flash`、`deepseek-v4-pro` | Provider 预设应使用官方别名；显示名称与模型别名分离，允许已审核的手动模型覆盖。 |
| 流式输出 | `stream: true` 时使用 SSE，`data: [DONE]` 结束；可请求 usage 块 | 首个真实会话调用可先保持现有非流式受限测试；产品 API 需要独立的流式会话合同和逐块 DTO，不得把原始事件流直接给 UI。 |
| 工具调用 | OpenAI function tools，最多 128；模型 arguments 仍需本机验证 | 任何 tool call 先映射进既有 capability/approval policy；绝不将模型 tool call 直接执行。 |
| JSON | `response_format: { type: "json_object" }`，提示必须明确要求 JSON | 只在受控内部结构化任务启用；客户端要显示截断/length 失败，不能把 JSON 解析失败静默吞掉。 |
| 推理 | `thinking.type`、`reasoning_effort` 可控 | P16 不把原始 reasoning content 持久化或回传 WebView；只可在受控的摘要/用量 metadata 中呈现。 |

## 2. 第三方 API 优先的准确边界

“第三方 API 优先”表示默认产品路径是让用户显式配置、激活并调用像 DeepSeek 这样的远程模型服务；它不意味着 WebView 将直接连接远程 Provider，也不意味着 API key 进入持久化。**真实调用仍由本机 Gateway 发起**，因为这使得连接目录、模型 allowlist、能力审批、失败归一化与 credential memory boundary 保持可审计。[2]

```text
用户输入 API key（显式动作）
  → Workbench（仅一次 HTTPS POST 到 127.0.0.1:4318）
  → Gateway session credential store（内存）
  → 已审核 DeepSeek driver（HTTPS 到 api.deepseek.com）
  → 脱敏结果 / 可控 SSE chunk DTO
  → Workbench 显示层
```

## 3. 差距与 P16 目标

现有 Workbench 已有 DeepSeek 预设、`configure-session`、`activate`、`probe` 和受限 `infer` 动作；其浏览器客户端固定为 `http://127.0.0.1:4318`，并拒绝 endpoint、header、API key 与自动执行字段进入 DTO。P16 将核验当前 driver 是否对齐新官方模型别名与请求字段，并补齐可测试的流式对话 transport 与可解释的 Provider runtime 状态。不会新增自定义 Provider URL、云端数据库、服务端账户、浏览器直连或自动工具执行。

## References

[1]: https://api-docs.deepseek.com/zh-cn/ "DeepSeek API docs: first API call"
[2]: https://api-docs.deepseek.com/zh-cn/api/create-chat-completion "DeepSeek API docs: Chat Completions API"
[3]: https://api-docs.deepseek.com/zh-cn/quick_start/pricing "DeepSeek API docs: models and pricing"
