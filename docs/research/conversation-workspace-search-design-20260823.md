# 对话工作区、历史记忆与独立联网搜索设计

## 根因

当前 `useDirectConversations` 已把用户/助手消息存入 `awo.direct-conversations.v1`，但 `directProviderClient.stream()` 只把本轮 `prompt` 传给 `start_direct_provider_stream`。Rust 侧的 OpenAI / Anthropic payload 也只构造一个当前用户 message。因此历史虽在 UI 可见、重启后可恢复，却从未被送到模型；这就是“下一次聊天像失忆”的直接原因。

同时，`ChatHome` 内部虽然可列出历史会话，但当前 `Sider` 不拥有会话或项目状态，`ProjectWorkspace` 只在项目页加载，并且项目账本仅关联 task/run。这三处状态未形成项目 → 会话 → 消息的显式关系，导致左栏无法像用户示例一样切换项目与对话。

## 状态所有权和兼容模型

| 状态 | 唯一所有者 | 本地持久化 | 发送给 Provider | 失败语义 |
|---|---|---|---|---|
| Provider 账户/原生会话 | `useProviderControlPlane` + Tauri `DirectProviderState` | 完整账户账本；启动重建 native session | 仅在用户发送时携带目标 model 与认证头 | 未连接时明确报错，不创建假回复。 |
| 会话、消息、活动与项目归属 | `useDirectConversations` | `awo.direct-conversations.v1`；保留既有 v1 会话，新增字段均为可选 | 同 Provider、同项目的当前会话消息尾部；不发送 API key、Base URL、活动原文或本地项目 metadata | 历史坏数据逐条降级；流失败保留用户消息、移除临时助手消息。 |
| 项目 metadata 与 task/run | `project-client` | `awo.projects.v1` | 永不发送 | 项目不存在时拒绝归属，不影响其它会话。 |
| 独立 Web 搜索 | Tauri 独立只读命令 | 仅把用户可见的来源摘要记为当前助手活动 | 只有用户在本轮明确开启时，将来源摘要作为标记为“不可信参考资料”的上下文附加到本轮输入 | 搜索失败显示搜索活动错误，并继续按用户选择决定是否发送无搜索上下文的普通聊天。 |

## 多会话和项目交互

会话记录新增可选 `projectId`。无项目归属的历史保留在“工作区”组；用户点击左侧项目时，工作区切换到该项目的会话目录，并从该项目最近一条对话恢复。若项目没有会话，主画布显示明确空态；点击左栏“新对话”才创建关联该项目的新会话。新建、切换、重命名、删除都只影响本地账本，不创建 Provider 请求。

每次发送的 Provider 输入由**同一 Provider、同一项目、当前会话**的安全消息尾部组成。为了避免单轮请求无限增大，发送时限制为最多 48 条可用消息和约 72,000 字符；消息顺序保持 user/assistant 原顺序，并含本轮用户消息。助手 reasoning、搜索活动、URL、项目 title、密钥和设置项不作为模型历史自动回传。

## 搜索双路模型

AtomCode 的独立工具路径与 MiMo Provider-native 搜索是不同能力，需并存：

| 路径 | 启用方式 | 流程 | 来源与成本 |
|---|---|---|---|
| 独立搜索（第一阶段实现） | 用户在本轮聊天显式开启“联网检索” | Tauri 原生命令向独立搜索服务发起只读请求，返回标题、URL、摘要；结果记为活动并作为已标注的不可信参考资料附加给本轮模型。 | 在回复下显示可点击来源；服务是否有免密层/配额、网络可达性和服务方条款由用户自行确认。 |
| MiMo 原生搜索（第二阶段兼容） | MiMo OpenAI-compatible 账户单独开关 | 对 MiMo 请求加入官方 `web_search` tool 字段，由 MiMo 决定或强制检索。 | 使用 MiMo 原生 citation 与 usage；需其插件在账户侧可用。 |

独立搜索不把任何 MiMo 专属字段发送给普通 OpenAI/Anthropic-compatible 端点。第一阶段不实现“模型自行递归调用任意工具”的代理循环；它是一个由用户显式选中的预检索动作，因而可看见、可折叠、可引用并与发送动作关联。后续如需完整 Agent 工具循环，应添加独立的工具调用事件状态机，而非塞进聊天文本流。

## 独立搜索服务核验

Exa 官方文档确认其远程 MCP 服务端点为 `https://mcp.exa.ai/mcp`，默认工具包含 `web_search_exa` 与 `web_fetch_exa`；免费方案适合日常使用，用户提供自己的 `x-api-key` 才可提升限额或用于生产。其 Search API 可返回结构化结果、摘要与网页 highlights，但官方文档将 API key 的生产集成与账户管理放在独立 Dashboard 中。

AI Work OS 将先使用与 AtomCode 类似的**远程 MCP 搜索端点**，只在用户为本轮消息明确选中“联网检索”后调用。它不需要 MiMo 插件，也不会使用或持久化 Exa 密钥；遇到服务端 429、网络错误或无结果时会把真实失败显示在该轮搜索活动中，不伪造来源或搜索结果。若用户将来需要更高限额，可在独立“搜索服务”设置页显式配置自己的 Exa key；该项不包含在本轮实现中。

参考：Exa Web Search MCP <https://exa.ai/docs/reference/exa-mcp>；Exa Search API <https://exa.ai/docs/reference/search-api-guide>。

## 本地界面核验

使用隔离的 Vite 浏览器预览创建“会话归属核验”本地项目后，项目立即显示在左侧“项目”目录，自动成为当前项目，并在其下呈现独立的“聊天”分组和“＋”新对话入口；项目页也同步显示该项目、说明与 0 个 task/run。该验证证明左栏读取的是本地项目账本而非 Gateway 或 Provider 响应。预览没有配置 Tauri 原生 Provider，因此未发送真实模型消息；预览测试数据将在验证结束后清理，不属于源码或 Windows 安装版数据。

最终自动化验证：全仓 `npm test` **310/310** 通过；TypeScript 检查和 Workbench 生产构建通过；Rust 侧的历史消息 payload、OpenAI / Anthropic 实际 reasoning SSE 解析、独立搜索 MCP SSE 解析与查询限长测试均通过；`cargo check` 与 `git diff --check` 通过。Vite 报告现有单个 Workbench JavaScript 压缩块约 790 KB 的性能提示，未影响本次功能正确性，后续可按功能拆分动态导入。
