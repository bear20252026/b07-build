# 官方 Provider 目录边界

本目录只列出已经根据厂商公开官方文档核验、并能映射到 AI Work OS 当前 **WebView → Tauri invoke/events → Rust reqwest HTTPS/SSE → 用户选择的第三方 Provider** 普通聊天链路的首批模板。它不是固定的总模型清单：模型可用性受账户、地区、套餐和厂商更新影响。

| 类型 | 行为 |
| --- | --- |
| 官方离线候选 | 在首页和设置页提供经过核验的常用模型标识，帮助用户开始配置。 |
| 当前账户发现 | 仅在用户点击“查询模型”后，使用当前 Provider 会话的密钥、协议和 Base URL 调用其模型列表接口。 |
| 用户手填 | 始终允许输入有效的模型名和 Base URL；静态目录与发现结果均不覆盖该输入。 |

首批包括 DeepSeek V4、Kimi、MiMo、LongCat、智谱 GLM、百度千帆／文心、百川智能、商汤日日新、阿里百炼 Qwen、腾讯混元／TokenHub、火山方舟／豆包、MiniMax、阶跃星辰与讯飞星火。仅支持 HTTP / HTTPS / SSE 的当前普通聊天模板会进入预设；厂商专属 WebSocket、签名认证、语音、图像生成、视频生成、异步任务或未核验参数不会被误标为普通聊天已支持。

## 重要约束

> Provider 预设只填写官方默认值，不替代用户在厂商控制台取得的真实地址、模型权限或套餐。包含工作区、地区或订阅专属端点的厂商仍要求用户明确填写／确认 Base URL。

本项目不启用 Gateway 回退。目录、模型发现和连接测试都只服务于用户选定的原生 Provider 会话。

## 官方来源

- [DeepSeek 模型与更新](https://api-docs.deepseek.com/zh-cn/updates/)
- [Moonshot AI / Kimi 文档](https://platform.kimi.com/docs/overview)
- [小米 MiMo 模型列表](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)
- [美团 LongCat API 文档](https://longcat.chat/platform/docs/zh/)
- [智谱 OpenAI 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)
- [百度千帆 OpenAI SDK 兼容说明](https://ai.baidu.com/ai-doc/WENXINWORKSHOP/2m3fihw8s)
- [百度千帆模型列表](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j)
- [百川智能 API 文档](https://platform.baichuan-ai.com/docs/api)
- [商汤日日新 OpenAI 兼容说明](https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode)
- [阿里云百炼模型列表](https://help.aliyun.com/zh/model-studio/models)
- [腾讯混元 OpenAI 兼容说明](https://cloud.tencent.com/document/product/1729/111007)
- [火山方舟 OpenAI SDK 说明](https://www.volcengine.com/docs/82379/1330310)
- [MiniMax OpenAI SDK 文档](https://platform.minimaxi.com/docs/api-reference/text-openai-api)
- [阶跃星辰 OpenAI 迁移说明](https://platform.stepfun.com/docs/zh/guides/developer/openai)
- [讯飞星火 HTTP 文档](https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html)
