# AI Work OS 0.1.12 首页跨厂商模型切换回归清单

本清单验证首页模型选择、当前会话模型控制和 Tauri 原生直接 Provider 请求使用同一份用户显式选择。普通聊天不得自动回退到 MiMo、Gateway 或任意其他连接。

| 场景 | 操作 | 通过条件 |
|---|---|---|
| 龙猫首页选择 | 在“厂商连接”选择龙猫，输入供应商提供的有效模型标识并发送新问题。 | 首页标题、消息元信息和本地 Provider 诊断的 provider/model 与龙猫选择一致；请求不发送到 MiMo。 |
| DeepSeek 首页选择 | 在“厂商连接”选择 DeepSeek，输入或选择 `deepseek-chat` 后发送。 | 下一轮聊天使用 DeepSeek 的原生 Provider session；模型输入不需要额外点击“使用此模型”才生效。 |
| MiMo 切回 | 从龙猫或 DeepSeek 显式切换到 MiMo 后发送。 | 仅在用户主动选择 MiMo 时才使用 MiMo；图片模型提示仍要求用户明确选择视觉模型。 |
| 自定义连接 | 配置一个自定义 OpenAI-compatible 或 Anthropic-compatible Provider，在首页输入有效模型标识并发送。 | 请求使用该自定义 connection 的 providerId、协议、Base URL 和用户输入模型；不会被预设厂商重写。 |
| 长会话控制 | 在已有 MiMo 历史会话中打开“模型”抽屉，选择龙猫或 DeepSeek 后发送下一轮。 | 当前选择即时更新；下一轮为新 provider 建立对应会话，不篡改原 MiMo 会话内容。 |
| 非法输入 | 将模型输入清空或输入带空格的无效标识。 | 不发起聊天请求，不回退到 MiMo；用户可恢复有效模型后继续发送。 |
| 直连边界 | 查看本地诊断和安装器清单。 | 普通聊天仍走 Tauri 原生 HTTPS/SSE，清单声明 `canAutoStartGateway=false` 与 `bundlesExplicitGatewaySidecar=false`。 |
