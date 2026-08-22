# AtomCode 第三方 API 连接实现调研

日期：2026-08-22

## 研究范围

本文只审阅 AtomCode 公共文档与公开源码中 Provider 配置、鉴权、模型发现、账户/模型管理相关实现；未运行其源码、脚本或二进制文件。

## 可验证事实

| 主题 | AtomCode 的实现 | 对 AI Work OS 的启示 |
| --- | --- | --- |
| 最短配置路径 | 官方文档提供 `/provider` 手动配置：选择供应商预置或自定义账号、填写 API key，再在该账号下添加一个或多个模型。 | 保持“选择服务 → 填写最少字段 → 连接并测试”的三步路径；不要额外要求用户先完成无关的登记或启动动作。 |
| 预置与自定义 | `ProviderPreset` 集中保存稳定的供应商 ID、协议、默认 Base URL、认证类型、建议环境变量及模型来源；未知供应商回落到 OpenAI-compatible。 | 将端点与鉴权规则集中在 SDK Provider 目录，UI 仅选择预置或填写自定义协议/Base URL。当前 AI Work OS 已采用静态目录与 OpenAI/Anthropic-compatible 自定义入口。 |
| 账户与模型分层 | `ProviderAccountConfig` 保存 Provider、Base URL、API key 等账号连接信息；`ModelProfileConfig` 保存模型名、上下文、能力与推理选项；`ResolvedModelConfig` 是运行时唯一消费的扁平视图。 | 后续可将一个连接账号下的多个模型独立为选择项，避免重复填写同一端点和密钥；本轮不改变现有 session-only 密钥持有边界。 |
| API key 处理 | 支持字面量、环境变量展开、按名称解析和协议默认环境变量回退；配置投影不回显密钥。 | AI Work OS 继续保持 API key 只进入 Gateway 当前会话内存；可在未来增加用户主动选择的环境变量引用，但不应默认持久化聊天中粘贴的密钥。 |
| 模型发现 | OpenAI-compatible 使用规范化后的 `/models`；Ollama 使用 `/api/tags`。发现只接受 `http/https`，剥离 query/fragment/URL 凭据；复用已保存凭据前先核对协议和规范化端点完全匹配。 | 继续以 `/v1/models` 或供应商官方 models 路径做显式连通测试；将拒绝、不可达、缺少密钥等结果显示为可操作中文说明。 |
| 诊断与可用性 | 有 10 秒发现超时、响应大小和模型数量上限；对配置错误与网络问题作区分。 | 本轮将 AI Work OS 的 `reachable/rejected/unreachable` 映射为明确的中文提示，避免只暴露内部 outcome 值。 |

## MiMo 对比结论

AtomCode 的内置 `xiaomi-mimo` 预置使用按量 API 的 `https://api.xiaomimimo.com/v1`，并走 OpenAI-compatible Adapter。AI Work OS 需要同时处理按量 `sk-` 与中国区 Token Plan `tp-` 的官方端点和 `api-key` 认证差异，因此保留两个清晰预置：**MiMo（按量）** 与 **MiMo Token Plan（中国）**。新加坡与欧洲 Token Plan 预置已按用户要求移除。

## 本轮可采纳改进

1. 将模型设置页切换为按需自动准备固定本机 Gateway，用户点击“连接并测试”前不再需要另行手动启动。
2. 只保留小米按量与中国区 Token Plan 两个入口，并在界面中提示 `sk-` 与 `tp-` 不可混用。
3. 把连通失败精确呈现为密钥/套餐拒绝、网络不可达或 Gateway 未就绪，而不是抽象状态码。
4. 保持自定义第三方的 HTTPS 公网连接能力，并保留本机/私网端点与系统执行的隔离边界；本地模型继续使用专用本地模型入口。

## 参考

1. [AtomCode Login Methods](https://atomcode.atomgit.com/docs/en/login.html)
2. [AtomCode Configuration](https://atomcode.atomgit.com/docs/en/configuration.html)
3. [AtomCode provider preset source](https://atomgit.com/atomgit_atomcode/atomcode)
4. [AtomCode provider account/model source](https://atomgit.com/atomgit_atomcode/atomcode)
