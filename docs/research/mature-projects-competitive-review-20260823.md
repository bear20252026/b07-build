# AI Work OS 成熟项目对比研究笔记

> 状态：调研中。此文件仅记录公开上游 README 与架构说明中的可核验信息；不能据此推断未在当前产品中实现的能力。

## 评估范围与方法

本轮把同类产品按主导能力分成四组：桌面 Cowork/Agent（OpenWorker、AionUi、OpenClaw）、编码智能体（AtomCode、ClawCode、DeepSeek-Harness、MiMo-Code）、多模型桌面聊天（Chatbox、Cherry Studio、Jan）和知识/工作台平台（AnythingLLM、Open WebUI、LobeHub）。评价维度为 Provider 兼容性、会话与记忆、文件/检索、工具执行、工作区/项目、运行可靠性、交互质量、发布与可维护性，以及许可证边界。

| 上游项目 | 当前可核验成熟做法 | 对 AI Work OS 的初步含义 | 许可证/复制边界 |
| --- | --- | --- | --- |
| OpenWorker | 本机桌面壳监督本地 agent server；BYOK、模型可选、连接器/MCP、文件/终端、审批前置、可调度任务、测试和端到端测试分层。 | 适合借鉴“任务工作区 + 可见执行记录 + 输出交付物”的产品模型；当前应先补稳定的工具活动账本与 Windows 回归，而非直接扩大连接器数量。 | MIT；复制源文件时保留原许可证与版权声明。 |
| AionUi | 内置 Agent、多 CLI Agent 统一界面、并行会话、MCP 管理、项目工作区、文件预览、多层 skills/assistants、跨设备入口和计划任务。 | 已借鉴其自动滚动交互并保留 Apache-2.0 声明；下一价值点是文件/变更检查器和明确的工具活动，而不是复制其完整多 Agent 平台。 | Apache-2.0；保留 LICENSE、NOTICE 和变更说明，不能以 AionUi 名称/资产暗示官方关系。 |
| AtomCode | OpenAI-compatible provider 配置、持久会话、`/context`/`/compact`、`/remember`、后台会话、diff/undo、结构化 turn datalog、读写/终端/搜索工具与验证循环。 | 最适合补齐 Provider 契约可见性、上下文预算、项目记忆审阅、Git 变更预览与明确的“计划/执行”会话活动。 | MIT；可借鉴架构与协议，若复制代码须完整保留来源。 |
| Chatbox | 本地数据、流式、Markdown/LaTex/代码、提示词库、消息引用、多平台桌面/网页/移动端以及打包/测试指令。 | 佐证应把聊天可靠性、渲染、快捷操作、迁移/备份和跨端数据契约置于新大功能之前。 | GPL-3.0；不能混入非兼容的专有/宽松许可项目而不整体履行 GPL 义务。 |
| Cherry Studio | 多 Provider、并行多模型会话、主题/透明窗口、MCP、拖放、文件/Office/PDF、Topic 管理，Roadmap 明确说明移动端与多窗口仍在推进。 | 可借鉴模型配置/并行结果呈现和 Topic 交互；不要把其 Roadmap 功能当作已实现能力。 | AGPL-3.0；直接复制会触发强 copyleft 义务，优先仅借鉴产品行为。 |
| AnythingLLM | 文档管线、向量库、引文、工作区记忆、模型路由、MCP、任务、可观测的遥测开关、多种部署形态。 | 当前缺口是“项目资产 → 解析 → 索引/引用 → 供会话使用”的稳定管线；应先完成实际文件提取状态和引用，而不急于在桌面包中嵌入重型向量数据库。 | MIT；需保留许可证和归属。 |
| LobeHub | 可编辑白盒记忆、项目/工作区、Agent/技能、计划任务与统一模型能力；项目本身为 Community License。 | “可见、可编辑、可审查的记忆”是正确方向；AI Work OS 的 `AI_WORK_OS_MEMORY.md` 应补受控追加/差异预览而非仅注入。 | Community License；不能将其视为 MIT/Apache 代码池，需逐文件审查。 |
| Jan | Tauri 桌面、离线模型 + 云模型、MCP、可对外提供 OpenAI-compatible localhost API、明确系统资源要求与故障排查。 | 可借鉴 Tauri 的本地能力分层、模型资源与诊断说明；本轮不宜承诺捆绑本地推理运行时。 | Apache-2.0；保留许可与归属。 |
| Open WebUI | OpenAI-compatible + 本地模型、可扩展工具、白盒记忆、队列消息、混合 RAG/网页检索、引用、可观测性、多存储和多模型并行。 | 给出长期工作台方向；当前桌面单机版应优先“检索每阶段状态、来源、取消、失败恢复”与可移植的数据模型，避免直接复制服务器级复杂度。 | 多许可证/品牌保留要求；直接复用前逐项审计，不得仅凭 README 复制。 |
| OpenClaw | 主设备上的控制平面（Gateway）统一会话、工具、事件、渠道；文档清楚区分网关、控制 UI、渠道和节点。 | 只在未来多渠道/多设备/后台自动化成为确认范围时参考其控制平面。当前普通 Provider 聊天应维持直连，不应为单次聊天增加中间服务。 | MIT；仍需保留许可证和来源。 |
| ClawCode | 明确的 `doctor` 运行状况诊断、Windows 安装/发布 smoke path、provider 与本地模型文档、会话/文件上下文规范及 mock parity harness。其 README 同时声明该仓库是实验性 exhibit，并非通用生产产品。 | 借鉴“发布后自检 + Windows smoke + mock parity”而非把它作为完整产品架构蓝本；当前需要一个桌面 `诊断报告` 页面，汇总 Provider、SearXNG、资源、版本和会话存储状态。 | MIT；但不得将其“非生产定位”或未实现的 ACP 状态误说成成熟能力。 |
| UI-TARS Desktop | GUI Agent、浏览器/计算机操控、视觉输入、实时状态，使用协议化 Event Stream；项目将本地/远程操作与 Agent TARS 分开说明。 | 若以后推进屏幕/浏览器控制，应先复用“事件流 + 可暂停/取消 + 明确的本地/远程对象边界”，不把图形控制混入普通 Provider 聊天。 | Apache-2.0；模型、SDK、截图和远程控制的权限/隐私说明需独立审计。 |
| DeepSeek Harness | 以 plugin 为核心的模块化设计、开发者预览明确提示会有破坏性改动、完整第三方通知与架构/测试目录。 | AI Work OS 已有 extension manifest 和 skill pack 控制面；下一步应优先定义稳定的执行/插件 API 版本，而不是把 metadata 直接变成自动执行。 | MIT；使用其插件概念时仍须自行定义兼容性与生命周期。 |
| MiMo-Code | 首次配置向导支持官方、OAuth 与 custom OpenAI-compatible Provider；项目记忆/检查点/任务进度分文件存储，SQLite FTS5 辅助跨会话记忆；上下文预算、压缩点和实际可用窗口可见；Plan/Build/Compose 模式区分明确。 | 与当前目标最直接一致：应新增“上下文组成与预算”可见面板、记忆候选差异预览、会话检查点和 project/task memory 的职责分离。它也提示不要把供应商宣传窗口误认为实际可用窗口。 | MIT；任何源文件搬运须保留许可证、版权和上游出处。 |
| agency-agents | 角色库按领域分文件，强调角色的使命、流程、交付物与成功指标，并提供面向多个工具的转换/选择安装方式。 | 当前预置角色应做成可检索、可启停、可查看来源和版本的“提示词资产”，而非将大量角色硬编码进首屏或隐式注入每轮上下文。 | MIT；保留原文件头、LICENSE 和来源。 |
| TokenTracker | 本地优先地采集 token、时间戳和模型信息，明确不读取 prompt/response；提供状态/doctor、项目归因、用量趋势、成本、限额和本地 SQLite 聚合。 | 当前已有调用量页面诉求但应先记录自己应用的逐请求账本（Provider、模型、输入/输出/缓存 token、延迟、错误类别），在供应商未返回真实 token 时如实标记“估算/不可用”。 | MIT；可借鉴数据最小化和诊断呈现，不能伪造供应商用量。 |

## 初步结论

AI Work OS 已拥有直接 Provider HTTPS/SSE、多会话、本地搜索、会话账本、项目记忆文件、消息复制、图片内容传递、GitHub 协作面板、Tauri/Rust 原生层和 GitHub Actions Windows 构建等基础能力。当前最大差距并不是“更多供应商名称”，而是把已有能力做成可验证的产品闭环：可见且可恢复的工具运行、实际 Windows 回归、文件/记忆的来源与审批链、上下文预算可解释性、Git 任务意图到本地确认执行的完整链路。

## 已核验来源

1. https://github.com/andrewyng/openworker
2. https://github.com/iOfficeAI/AionUi
3. https://atomgit.com/atomgit_atomcode/atomcode
4. https://github.com/chatboxai/chatbox
5. https://github.com/lobehub/lobehub
6. https://github.com/CherryHQ/cherry-studio
7. https://github.com/Mintplex-Labs/anything-llm
8. https://github.com/janhq/jan
9. https://github.com/open-webui/open-webui
10. https://github.com/openclaw/openclaw
11. https://github.com/ultraworkers/claw-code
12. https://github.com/bytedance/UI-TARS-desktop
13. https://github.com/deepseek-ai/deepseek-harness
14. https://github.com/XiaomiMiMo/MiMo-Code
15. https://github.com/msitarzewski/agency-agents
16. https://github.com/xiufengsun/TokenTracker
