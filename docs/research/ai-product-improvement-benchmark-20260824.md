# AI Work OS 成熟 AI 产品改进基准

**调研日期：** 2026-08-24  
**目的：** 以当前 AI Work OS 的 Windows 原生直连、会话、搜索、记忆与 GitHub 协作能力为基线，识别下一阶段优先改进点。本文仅提出产品路线，不构成自动实施授权。

## 一手资料观察

| 产品/标准 | 已核验实践 | 对 AI Work OS 的启发 |
|---|---|---|
| OpenCode | 终端、桌面与 IDE 扩展共用体验；使用仓库内 `AGENTS.md`；Plan/Build 模式；项目级 `/undo`、`/redo` 与显式共享会话。 | 将当前可见 `AI_WORK_OS_MEMORY.md` 升级为“项目说明 + 提议式记忆变更 + 可恢复检查点”的白盒工作流。 |
| Cursor | 将模型、Plan、Agent Review、Rules、Skills、Subagents、Hooks 与 MCP 集中于可发现的产品表面。 | 设置页不应仅展示 Provider 表单，应形成能力卡、任务模式和工具状态的统一信息架构。 |
| Cline | 计划/执行分离、差异审阅、检查点/撤销、项目 rules/skills、多 Agent worktree、插件与 MCP。 | 优先构建“计划 → 变更预览 → 检查/测试 → 明确提交”的本地工作流，再评估并行 Agent。 |
| LibreChat | 自定义端点、模型切换、可恢复流、上下文使用量、可读 Agent 活动、动态工具刷新、消息虚拟化与本地/集中可观测性。 | 将已有 Provider 诊断扩展为会话级请求时间线、首 token/完成延迟、模型/视觉能力、检索来源和 token 上下文预算的可见账本。 |
| OpenHands Agent Canvas | 多后端 Agent 控制台、ACP、工作区隔离、后台自动化和运行记录；明确区分本机/容器/云端后端。 | 现有 Adapter manifest 与受控扩展应先接入真实 transport 与单一工作区运行，再考虑持久后台/跨端。 |
| GitHub Copilot cloud agent | 研究→计划→分支改动→差异审阅→PR 的透明链路；短时隔离环境；按任务专用 Agent；产物和日志可追踪。 | 本地 GitHub 面板应增加“生成变更计划/提交草案/测试摘要”并继续保持最终 push 明确确认。 |
| MCP | 用统一开放协议连接数据、工具与工作流，拥有广泛客户端生态。 | 先提供受控 MCP 客户端的健康检查、工具目录、逐工具权限和调用收据；不将 manifest 等同于自动执行权。 |
| OpenAI Agents SDK | 会话、手交、隔离 sandbox、人工介入、追踪与评估是独立原语。 | 为任务化功能建立 run/retry/取消/恢复与评估记录，而不是仅在聊天中堆叠工具按钮。 |

## 当前产品已具备的基础

当前桌面交付已经具备 Direct Provider HTTPS/SSE、OpenAI/Anthropic 兼容协议、MiMo 认证及图片模型提示、多个本地会话、部分虚拟化/自动滚动、图片与文档发送、混合检索、内置 SearXNG、可见项目记忆、确认式 GitHub 面板、无密钥 Provider 诊断，以及 Windows SChannel 与系统代理兼容。项目核心架构还声明了可恢复任务、策略、审批、Provider Profile、Skill Pack 和 Adapter metadata 等控制面。

因此，接下来最大的差距不是再增加 Provider 名称，而是把已经存在的控制面和聊天能力形成用户可以看见、恢复、审核和度量的**执行闭环**。

## 许可证边界

本轮只对产品实践做比较，不复制任何源代码。若后续复用实现，必须逐文件核验许可证和 NOTICE：Cline、Continue 为 Apache-2.0；OpenHands 与 LibreChat 为 MIT；Cursor、GitHub Copilot 与 OpenAI Agents SDK 文档只适合作为行为参考，不能视为可复制源码授权。

## 来源

1. OpenCode 文档：<https://opencode.ai/docs>
2. Cursor 文档：<https://docs.cursor.com>
3. Cline 仓库：<https://github.com/cline/cline>
4. LibreChat 仓库：<https://github.com/danny-avila/LibreChat>
5. OpenHands 仓库：<https://github.com/OpenHands/OpenHands>
6. GitHub Copilot Cloud Agent 文档：<https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent>
7. Model Context Protocol 文档：<https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro>
8. OpenAI Agents SDK 文档：<https://openai.github.io/openai-agents-js/>
