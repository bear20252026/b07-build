# MiMo 图片、模型切换与搜索兼容性核验

**核验日期：** 2026-08-23  
**范围：** MiMo Token Plan 中国区、OpenAI-compatible / Anthropic-compatible 协议、图片输入与联网搜索。

## 官方结论

| 主题 | 官方结论 | 对 AI Work OS 的约束 |
|---|---|---|
| Token Plan 中国区 | OpenAI-compatible Base URL 为 `https://token-plan-cn.xiaomimimo.com/v1`，Token Plan 的 `tp-` 密钥须匹配专属 Base URL 与认证格式。 | 无论预设或自定义连接，只要为 `tp-` 密钥就走 MiMo 官方 `api-key` 认证头；不得以 Gateway 中转。 |
| 文本与视觉模型 | `mimo-v2.5-pro` 提供文本、深度思考、流式、函数调用、结构化输出和 Web Search；`mimo-v2.5` 增加全模态理解。 | 模型选择可自由切换，但图片附件应将活动模型从纯文本能力与视觉能力明确区分；图片不能静默丢弃。 |
| 图片输入 | 图片理解当前仅支持 `mimo-v2.5`；支持公开 URL 或 Base64。OpenAI-compatible 使用 `image_url` 的数据 URI，Anthropic-compatible 使用 `image`/`source` 的 base64 结构。 | 使用 `mimo-v2.5-pro` 上传图片得到 404 与官方“端点或模型不支持图片”错误码一致，应提示用户切换到 `mimo-v2.5`，而不是误报网络、Gateway 或本地拦截。 |
| 图片限制 | 支持 JPEG、PNG、GIF、WebP、BMP；URL 或 Base64 单图最大 50 MB。 | 当前本地图片支持 PNG/JPEG/GIF/WebP；需按 Provider/模型能力显示限制，不在端点不兼容时继续伪造成功。 |
| 供应商原生 Web Search | MiMo 模型列表将 Web Search 标为 `mimo-v2.5-pro` 与 `mimo-v2.5` 的能力。 | 自建 Exa/SearXNG/last30days 检索必须与 Provider 聊天解耦：检索失败只显示本轮活动失败，仍发送原始问题；Provider-native 搜索须以明确工具契约单独实现，不能假定所有兼容端点支持。 |
| 错误 404 | 官方错误表明端点或模型不支持图片输入。 | 保留 `provider-http-404-image`，并将 MiMo 预设指向支持视觉的模型选择建议。 |

## 修复原则

1. 允许任何兼容 Provider 保持自由模型名输入与模型目录选择；对已知 MiMo 模型仅提供能力提示，不强制锁定。
2. 检测到图片且已知活动 MiMo 模型为 `mimo-v2.5-pro` 时，不替换模型或删图；在发送前明确提示推荐切换至 `mimo-v2.5`，并让用户主动确认或保持当前模型继续请求。
3. 对 MiMo 的 OpenAI-compatible 图像 payload 使用官方 `image_url` + `data:{mime};base64,...` 结构，Anthropic-compatible 使用 `image` + `source` base64 结构。
4. 搜索后端应返回独立回执；即使 SearXNG/Exa/last30days 失败，普通文本聊天不得被阻止。

## 来源

1. [MiMo Image Understanding](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding)
2. [MiMo Models](https://mimo.mi.com/docs/quick-start/summary/model)
3. [MiMo Token Plan OpenCode Configuration](https://mimo.mi.com/docs/en-US/tokenplan/integration/opencode)
4. [MiMo Error Codes](https://mimo.mi.com/docs/en-US/api/guidance/error-codes)
