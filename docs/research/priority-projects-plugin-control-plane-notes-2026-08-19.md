# 重点国际项目：插件化与控制面研究

**日期：2026-08-19**

## 核验的上游定位

| 项目 | 官方公开定位 | 可复用的模式 | 本项目适配边界 |
| --- | --- | --- | --- |
| OpenClaw | 可扩展的本地优先 Agent 运行时；插件可覆盖 provider、channel、tools、skills、agent harness、媒体与服务 | manifest-first、allow/deny、激活计划、运行时 inspect/doctor、能力所有权 | 作为受控 Extension Plane 的首要架构蓝本；不自动安装或执行扩展。 |
| DeepSeek-Harness | Cordis 驱动的“everything is plugin” Agent harness；模型、工具、会话、沙箱、存储、loops、调度和 UI 都可组合 | 插件服务/事件、可组合 preset、append-only trajectory | 只吸收组合与可追溯思想；其 developer-preview API 不能作为稳定运行时依赖。 |
| ClawCode | Rust CLI harness，强调 `doctor`、会话、离线 OpenAI-compatible 模型、技能安装、容器工作流和 Rust parity | Rust 健康诊断、deterministic mock parity、CLI-first control path | 扩展 host 使用 Rust supervisor 保障进程健康、版本/ABI 与 crash containment。 |
| AionUi | 跨平台 Cowork 工作台，聚合 20+ CLI agents；独立会话、并行协作、MCP 统一管理、每 agent 审批与预览面板 | agent adapter、会话隔离、待审批 inbox、产物多格式预览、团队任务板 | 借鉴 UI 信息架构；任何外部 agent 仍须在本地 Gateway 授权、事件审计和 profile 预算内运行。 |
| OpenWorker | 本地 Python agent server + GUI shell + 25+ connectors；有 per-launch token、approval gate、离线模型、调度和交付物导向 | 完成本而非聊天、sidecar token、审批 inbox、连接器与 MCP per-tool 控制 | 强化 Runtime Gateway 的短期令牌、connector 安装审查和交付物/审批闭环。 |
| CC Switch | Tauri/Rust + SQLite 的多 CLI/provider 管理器，支持多工具 API/provider 切换 | provider profile、端点健康、CLI 配置隔离、可回退的切换记录 | 在已有 LocalEndpointRegistry 上增加 provider profile manifest、健康检查、回滚和可解释路由，不接入未审查 API relay。 |

## 统一插件化结论

DeepSeek-Harness 的“everything is plugin”可以 **适配为：一切业务能力可声明为扩展，但没有任何扩展天然可执行**。核心可信基底持有身份、任务、政策、审批、预算、事件和 SQLite append-only 存储；扩展必须首先是 metadata，而非 import 后的代码。

推荐的可组合类别为：`model-provider`、`knowledge-importer`、`tool-adapter`、`skill-pack`、`agent-harness`、`connector`、`ui-panel`、`scheduler-adapter`、`media-worker`。每项都必须声明：`id`、`version`、`apiVersion`、`capabilities`、`dataBoundary`、`resourceBudget`、`risk`、`sourceDigest`、`entry`、`requestedPermissions` 和兼容性范围。

推荐的核心扩展生命周期为：`discovered → reviewed → installed → disabled → planned → activated → suspended → revoked`。只有 `planned`、`activated` 两步允许生成运行时加载计划；其余步骤只可处理 metadata。任意配置/目录/版本变化都重建不可变 metadata snapshot；绝不静默用 TTL 缓存替代版本核验。

## References

[1] [OpenClaw Plugin Internals](https://docs.openclaw.ai/plugins/architecture)  
[2] [OpenClaw Plugin Management](https://docs.openclaw.ai/tools/plugin)  
[3] [DeepSeek Harness Developer Preview](https://deepseek.com/harness/en/)  
[4] [DeepSeek Harness Repository](https://github.com/deepseek-ai/deepseek-harness)  
[5] [ClawCode Repository](https://github.com/ultraworkers/claw-code)  
[6] [AionUi Repository](https://github.com/iOfficeAI/AionUi)  
[7] [OpenWorker Repository](https://github.com/andrewyng/openworker)  
[8] [CC Switch Repository](https://github.com/farion1231/cc-switch)

## LobeHub 补充结论

LobeHub 当前主仓库采用 **LobeHub Community License**，应继续仅作产品模式参考；其 `@lobehub/icons` 和 Chat Plugin SDK 则为 MIT，适合作为依赖或接口参考。主产品将 agent 作为工作单元，强调 Agent Builder、Agent Groups、Pages、Schedule、Project、Workspace 与白盒可编辑记忆；其插件模型用于扩展 function calls 和结果渲染。[9] [10]

对 AI Work OS 最有价值的不是复制主仓库，而是将其产品观念映射为受控 UI 表面：`Extension Health`、`Activation Plan`、`Approval Inbox`、`Agent/Plugin Workspace` 与可编辑但不自动生效的 Memory/Skill 草稿。LobeHub 插件的“结果渲染”应在本项目作为**纯浏览器 UI panel**扩展：不得触达 SQLite、provider secrets、工具执行或 Gateway 直连。

[9] [LobeHub Repository](https://github.com/lobehub/lobehub)  
[10] [Lobe Chat Plugin SDK](https://github.com/lobehub/chat-plugin-sdk)
