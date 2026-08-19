# 本地模型端点注册与健康路由设计笔记

**作者：Manus AI**  
**日期：2026-08-19**

## 公开接口观察

Ollama 的 OpenAI 兼容层以本地 `http://localhost:11434/v1/` 为示例，并支持只读的 `/v1/models` 枚举；其聊天端点支持工具和视觉能力，但模型元数据不能可靠推断这些能力，因此本项目采用用户显式声明的 capabilities。[1] llama.cpp server 同时提供 OpenAI 兼容 API、监控端点与默认 `127.0.0.1` 绑定，适合作为受限回环注册表的来源。[2] Open WebUI 将服务健康、模型连通性和真实推理检查分为不同等级；其中模型枚举比发送推理请求更轻量且没有执行成本。[3]

| 本项目决策 | 原因 | 安全约束 |
| --- | --- | --- |
| 仅允许 `localhost`、`127.0.0.1` 和 `::1` 的 `http(s)` 端点 | 本地模型的默认绑定是回环地址。[1] [2] | 拒绝私网、公共地址、userinfo、查询参数与片段，防止 SSRF。 |
| 注册后以 `HEAD` 再回退 `GET` 探测 `/health` 或 OpenAI `/v1/models` | 公开服务将基础健康与模型连通性分层。[3] | 探测为只读请求，不发送 prompt、不触发推理。 |
| capabilities、contextWindow、离线状态为显式登记元数据 | `/v1/models` 提供模型列表，但模型能力与运行时 context size 没有统一可移植的枚举格式。[1] | 不从端点返回文本隐式提升工具或视觉权限。 |
| 路由仅消费最近健康、非 offline 的本地端点 | 健康和模型连通性是不同状态，路由必须可解释且可回放。[3] | 未探测、失败或过期端点均不具备本地优先资格。 |

> **边界：** 端点注册只解决本地模型的发现与路由候选，不保存 API 密钥、不调用模型、不改变 Capability Policy，也不将 provider 声称的功能解释为工具授权。

## 参考文献

[1]: https://docs.ollama.com/api/openai-compatibility "Ollama OpenAI compatibility"
[2]: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md "llama.cpp HTTP Server"
[3]: https://docs.openwebui.com/reference/monitoring/ "Open WebUI Monitoring"

## References

[1] [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)  
[2] [llama.cpp HTTP Server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)  
[3] [Open WebUI Monitoring](https://docs.openwebui.com/reference/monitoring/)
