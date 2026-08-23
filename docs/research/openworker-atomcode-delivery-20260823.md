# OpenWorker 与 AtomCode 对标结论及本轮桌面端改造

> **结论摘要**：本轮已完成首页由“任务欢迎卡”切换到“沉浸式聊天画布”的真实交互，并让供应商实际返回的 reasoning / thinking 流分块以默认折叠方式呈现。联网搜索不能作为所有 OpenAI-compatible 服务的通用开关强塞进请求体；需要按供应商协议实现，并由你选择首个落地路线。

## 本轮已交付

| 项目 | 实现状态 | 具体行为 |
|---|---|---|
| 输入即切换聊天 | 已完成 | 用户在首页输入框键入任意非空草稿时，中央欢迎区、工作方式选择、模型摘要和建议卡片都会向上退出；中央区域只保留“开始新的对话”提示与底部输入面。清空草稿后恢复。整个过程不发送模型请求。 |
| 已有对话主画布 | 已保留并增强 | 真正发送后，用户与助手消息在中央时间线中展示；历史会话可继续恢复。 |
| 可折叠模型过程 | 已完成 | 原生 SSE 现在识别 OpenAI-compatible 的 `reasoning_content` / `reasoning` 与 Anthropic 的 `thinking` 分块。只有供应商实际返回这些内容时，才显示默认折叠的“模型过程（供应商实际返回）”；不会生成伪造的思考文本。 |
| Provider 直连 | 保持 | WebView → Tauri 原生 `reqwest` HTTPS/SSE → 第三方模型 → Tauri 事件 → WebView；本轮未重新引入 Gateway、sidecar 或 `127.0.0.1:4318` 作为第三方模型必经链路。 |

已推送源码提交：`ebf601e feat: focus chat canvas and surface provider reasoning`。

## 两个参考项目有哪些成熟之处

| 对标点 | OpenWorker | AtomCode | AI Work OS 当前情况与差距 |
|---|---|---|---|
| 多 Provider / 模型账户 | 预置多供应商、API key、手填模型、本地 Ollama 并存。 | OAuth 与 API key 并存，一个 Provider 下可维护多个模型。 | 已具备预置 + 自定义、地址/协议/模型名、启动原生会话重建。缺少“一个账户维护多个模型”的明确账户页和默认模型管理。 |
| 多会话与项目 | 面向完成品与交付物，协调会话、文件、连接器和任务。 | 会话按项目归属，支持搜索、重命名、删除、恢复、停止和上下文压缩。 | 已具备本地项目账本、任务引用、最多 32 条本地对话恢复。缺少会话搜索、重命名、删除、停止、上下文压缩与项目交付物的直接关联。 |
| 过程展示 | 明确计划、步骤、审批与交付而不只是聊天。 | SSE 事件区分文本、reasoning、工具调用、token、错误等，前端按类型呈现。 | 本轮新增真实 reasoning 折叠；缺少统一的“工具调用 / 网页来源 / token / 停止”事件时间线。 |
| 联网与工具 | 本地引擎使用连接器、MCP、文件与终端，实际行为可被用户确认。 | 内置 Web、文件、Shell、代码图工具；支持 MCP，并可按运行禁用某类工具。 | 当前直接 Provider 是聊天流驱动，尚未拥有搜索工具契约、来源引用模型、工具审计记录或按 Provider 路由。 |
| 可恢复性 | 本地保存对话、配置与连接器状态。 | 会话/项目为独立资源，能够恢复、检索和撤销。 | 已保存对话、项目、Provider 账户与任务模型选择；后续应补齐会话目录操作与可审计的消息事件模型。 |

## 优先级建议

| 优先级 | 应补能力 | 原因 |
|---|---|---|
| P1 | 会话搜索、重命名、删除、停止生成与项目归属 | 这是多任务工作台的基本可用性，复用现有 localStorage 会话账本即可，无需改变 Provider 直连。 |
| P1 | 统一活动事件：reasoning、搜索、工具、来源、token、错误 | 能把“模型过程”从单一折叠文本扩展为真实可审计时间线，接近 AtomCode 的事件模型。 |
| P2 | Provider-native 联网搜索 | 先完成 MiMo，再按 OpenAI Responses API 与 Anthropic Messages API 分别实现；不要向一般兼容端点发不兼容字段。 |
| P2 | 可管理的 MCP / 外部工具入口 | 需要单独的工具目录、每会话启停、来源、失败和权限记录，不能挤进 Provider 配置页。 |
| P3 | 长对话上下文压缩和交付物关联 | 当会话规模、文件和任务结果积累后再实施，避免现在过早引入复杂 Agent 运行时。 |

## 联网搜索的两条可行路线

| 方案 | 用户体验 | 优点 | 约束与成本 |
|---|---|---|---|
| **A. 先接入 MiMo 原生 Web Search** | 在 MiMo Token Plan / 按量账户选择模型后开启“联网搜索”；模型按意图或强制搜索；结果附带可点击引用。 | 与你已经配置的 `mimo-v2.5-pro` 和 OpenAI-compatible 地址匹配，官方已定义 `tools: [{ type: "web_search" }]`、来源返回与用量字段。 | 必须先在 MiMo 控制台启用 Web Search Plugin；只支持其 OpenAI-compatible 协议，搜索和网页内容会产生额外费用；需实现引用和搜索用量展示。 |
| **B. 同时建立多供应商原生搜索层** | 每个账户页显示该供应商实际支持的搜索开关、域名过滤、次数限制和来源。 | OpenAI、Anthropic、MiMo 都能使用各自原生搜索，不把模型工具权限交给另一个服务。 | 协议不同：OpenAI 使用 Responses API，Anthropic 使用 Messages server tool，MiMo 使用 Chat Completions tool；实现和测试量更大，需按账户分别验证能力与计费。 |
| **C. 自建统一搜索工具** | 任意兼容模型都可选择一个公共搜索服务，结果作为工具输出展示。 | 对自定义模型的覆盖面最大，界面统一。 | 需要另选搜索服务、单独 API key 与资费、来源许可和工具结果处理；不应在未经你确认时把检索服务接入或自动外发查询。 |

> **建议**：先选择 A，获得最快的真实联网体验；随后在同一“活动事件 + 引用”数据模型上扩展 B。C 只在你明确需要“所有自定义兼容模型都能统一搜索”时再做。

## 验证范围

| 检查 | 结果 |
|---|---|
| 全仓测试 | `npm test`：309/309 通过。 |
| TypeScript 与 Workbench 构建 | 通过。 |
| 原生 SSE 单元测试 | 新增 OpenAI text/reasoning 与 Anthropic text/thinking 解析测试，2/2 通过。 |
| 视觉核验 | 本地预览确认空白首屏无纵向溢出；输入中文草稿后欢迎/右侧卡片退出、中央画布接管、草稿保留且不触发模型调用。 |
| 未验证项 | 尚未用真实第三方模型账号验证供应商是否返回 reasoning 分块；不同模型可能不返回此类内容，届时界面不会显示过程折叠项。 |

## 资料与版权说明

本轮只研究公开的产品模式、文档与接口职责，没有复制、导入或分发 OpenWorker、AtomCode 的源码、品牌、图标、资产或账户凭据。后续若进行代码级复用，必须逐文件确认许可证、保留版权头并补充第三方声明。

## 参考资料

1. [OpenWorker GitHub README](https://github.com/andrewyng/openworker)
2. [AtomCode Documentation](https://atomcode.atomgit.com/docs/en/)
3. [AtomCode Login Methods](https://atomcode.atomgit.com/docs/en/login.html)
4. [AtomCode Headless & Daemon / SSE](https://atomcode.atomgit.com/docs/en/headless-daemon.html)
5. [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)
6. [Anthropic Web Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
7. [MiMo Web Search](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/tool-calling/web-search)
