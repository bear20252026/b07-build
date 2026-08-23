# OpenWorker 与 AtomCode：Provider、会话与执行交互调研

## 资料范围与版权边界

本记录仅提炼公开仓库和官方文档的产品模式、接口职责与交互原则；AI Work OS 不复制、分发或改名使用 OpenWorker、AtomCode 的源码、图标、品牌、模型资产、OAuth 凭据或配置文件。两项目均公开标注 MIT 许可，但任何未来代码级复用仍须逐文件核实源文件版权头、依赖许可和兼容性，并在 `THIRD_PARTY_NOTICES.md` 中保留应有声明。

## 已核实的成熟模式

| 维度 | OpenWorker | AtomCode | 对 AI Work OS 的可借鉴结论 |
|---|---|---|---|
| Provider | 用户自带 API key，可切换多供应商及本地 Ollama；经过验证的模型清单与手填模型并存。 | OAuth 套餐与 API key 并列；供应商下允许一个或多个模型，配置可持久化。 | 维持当前“预置与自定义平等、手填地址/协议/模型可用”的设计；将账户配置、模型选择、原生会话恢复拆层。 |
| 会话与项目 | 任务以结果和交付物为中心，桌面端协调本地引擎、文件和连接器。 | 将会话、项目目录和历史作为独立资源，支持创建、搜索、重命名、删除及恢复。 | 当前已有本地项目账本和多会话；下一步应补齐会话重命名、搜索、停止、折叠和交付物关联，不应混入 Provider 配置。 |
| 流式过程 | 公开说明强调计划、步骤、审批与交付结果。 | SSE 区分文本、reasoning、工具调用、token 统计和错误事件，界面可以按事件类型渲染。 | 对话应以“最终回复”为主，实际收到的过程、工具调用和用量可按消息折叠展示；不能杜撰未由供应商返回的思考内容。 |
| 工具与联网 | 本地引擎结合连接器、MCP、文件与终端，关键操作须明确确认。 | 内置工具分为文件、shell、代码图、Web 与自动化，支持 MCP；可按运行禁用工具。 | 联网搜索需要独立工具契约和用户发起授权，不能伪装为普通聊天或把任意网页结果直接作为可信指令。 |

## 官方资料

1. OpenWorker README：<https://github.com/andrewyng/openworker>
2. AtomCode 文档首页：<https://atomcode.atomgit.com/docs/en/>
3. AtomCode 登录与 API key：<https://atomcode.atomgit.com/docs/en/login.html>
4. AtomCode daemon / SSE 事件与 Provider API：<https://atomcode.atomgit.com/docs/en/headless-daemon.html>

## 联网搜索：供应商原生能力不能用一个通用开关伪装

| 路线 | 实际协议与前提 | 结果与 UI 必须保留的内容 | 适用范围 |
|---|---|---|---|
| MiMo 原生搜索 | 仅 OpenAI-compatible Chat Completions；账户必须先在 MiMo 控制台启用 Web Search Plugin。请求中加入 `tools: [{ type: "web_search", ... }]`；支持 `force_search`、关键词上限和位置。 | 流式首包搜索来源、最终回答中的 URL citation、搜索次数与可能的额外计费。 | 当前用户已配置的 MiMo `mimo-v2.5-pro` 路径，最适合作为第一种实现。 |
| Anthropic 原生搜索 | Messages API 的版本化 `web_search_*` server tool；可限制次数、域名、位置；部分版本支持动态过滤。 | `server_tool_use`、结果、引用、错误和暂停回合的完整块，不能只保留最后文本。 | 原生 Anthropic 账户；不能假设每个 Anthropic-compatible 代理都支持。 |
| OpenAI 原生搜索 | 新集成使用 Responses API 的 `web_search` tool；该路线与当前 Chat Completions 请求体不同。 | 搜索动作和内联 URL citation；若展示给用户，引用必须可点击。 | OpenAI 原生账户与明确切换到 Responses API 的独立 Provider 驱动。 |
| 本地独立搜索工具 | AI Work OS 直接调用用户选择的检索服务，再把结果以工具输出交给模型；需要单独的服务账户、费用与来源处理。 | 本地工具活动、搜索词、来源、失败原因与引用；需要用户选择服务和明确授权。 | 需要跨所有兼容 Provider 统一体验时；不应未经确认自动启用。 |

当前 `direct_provider.rs` 是一个最小的 OpenAI-compatible / Anthropic-compatible 聊天流驱动，尚未携带原生搜索工具请求体，也没有统一的 citation 数据模型。因此不应在“普通 OpenAI-compatible”模式里悄悄插入搜索字段；这会令大量中转服务或自定义模型返回参数错误。第一阶段已经实现的 reasoning 折叠只显示 SSE 中真实出现的 `reasoning_content` / `reasoning` 或 Anthropic `thinking` 分块；无此分块的模型不会凭空显示“思考过程”。

## 本地预览核验备注

首次打开 Workbench 开发预览时，浏览器存有先前功能核验留下的对话历史和草稿，因此页面直接处于已有会话状态，不能代表本次首页的空白首屏。本次视觉核验会先清理**仅预览浏览器**中的 `awo.direct-conversations.v1` 和模型选择临时数据，再分别检查空白、输入中和有回复三种状态；不触碰 Windows 安装版或用户的本地数据。

空白状态已核验：欢迎区、工作方式、第三方模型连接摘要、建议提示与输入框均在同一桌面视口可见，页面没有纵向内容溢出。下一步以该状态为对照，检查输入非空时卡片是否完全退出并让中心画布接管空间。

输入状态已核验：在草稿框输入中文任务但不发送后，欢迎区、工作方式、Provider 摘要和建议卡片均向上退出，中心仅保留“开始新的对话”提示和底部输入面；草稿内容保留，且预览页面没有产生模型调用或网络请求。清空草稿即可恢复空白首屏引导。

官方资料：

5. OpenAI Web Search：<https://developers.openai.com/api/docs/guides/tools-web-search>
6. Anthropic Web Search Tool：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>
7. MiMo Web Search：<https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/tool-calling/web-search>

## AtomCode 联网能力核验：不依赖 MiMo 插件

已直接核验 AtomCode 本地公开镜像的 `crates/atomcode-capabilities/src/tools/web_search.rs`。其内置 `web_search` 是一个独立、只读的 Agent 工具，而非 MiMo Provider 的请求参数：默认经 Exa MCP 服务 `https://mcp.exa.ai/mcp` 调用 `web_search_exa`，可选 API key 仅用于提高 Exa 配额；另有不需要 key 的 DuckDuckGo HTML 路径。该工具用 `reqwest` 发出 JSON-RPC `tools/call` 并从 SSE 结果中解析标题、URL 与摘要文本；失败时建议模型使用浏览器型 Web Access skill。它同时另有 MCP registry、OAuth 与 `web_fetch` 工具实现。

因此，用户无需启用 MiMo Web Search Plugin 也可以在 AtomCode 中联网搜索是合理的：AtomCode 使用的是自己的工具层与独立检索服务，而不是模型供应商的原生搜索。AI Work OS 将保持两条**分离且显式**的路线：

1. **独立搜索工具**：按 AtomCode 的职责模式，搜索服务单独配置并把工具活动、来源、错误和引用记为会话事件；它可服务于任何已连接的聊天模型。
2. **MiMo 原生搜索**：只在 MiMo OpenAI-compatible 连接且用户明确启用后把 `web_search` 工具字段交给 MiMo；可获取其官方返回的引用与搜索用量。

两条路线不会互相伪装、不会把 MiMo 字段发给普通兼容端点，也不会自动发送用户查询。注意：本项目不复制 AtomCode 的代码；上述结论仅复用其“工具能力独立于模型 Provider”的职责分层。
