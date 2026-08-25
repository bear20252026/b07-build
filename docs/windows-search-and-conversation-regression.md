# NOVA Windows 搜索与会话回归清单

本清单用于每次 Windows hosted runner 候选安装器构建后进行人工复核。它不包含 API key、聊天正文、网页正文或诊断中的敏感值。

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 联网搜索来源上限 | 开启联网搜索并发起一轮可返回多个来源的问题 | 聊天活动只报告并展示最多 10 个来源；第 11 个及后续来源不会进入该轮 Provider 上下文。 |
| 来源可见与外部打开 | 点击任一来源卡片中显示的完整 URL | 仅由 Windows 默认浏览器打开 `http` 或 `https` 地址；WebView 不导航，不接受文件、脚本或自定义 scheme。 |
| 连续两轮聊天 | 同一会话连续发送两条问题，并等待每轮流式输出完成 | 第一轮 user／assistant 消息仍保留在时间线；第二轮使用独立消息身份，不能覆盖第一轮回复。 |
| 会话切换 | 在两条以上会话间切换，再返回原会话 | 已完成的 assistant 回复按原顺序保留，滚动窗口不改变历史内容。 |
| 首页模型候选 | 连接一个名称或历史 ID 含 DeepSeek 的直连账户 | 首页模型候选包含 `deepseek-v4-flash`；当前模型和用户手填模型仍可选择。 |
| Halo Search | 点击标题栏“查找”或按 `Ctrl/⌘+Shift+K` | 搜索面板位于标题栏与工作区上方；顶部不出现模糊，背景不可交互，Esc 可关闭。 |

普通聊天必须继续通过 WebView → Tauri invoke/events → Rust reqwest HTTPS/SSE → 用户选择的第三方 Provider 运行。联网搜索、来源打开与 Halo Search 不得产生 Gateway 回退。
