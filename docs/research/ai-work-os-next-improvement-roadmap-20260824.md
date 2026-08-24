# AI Work OS 下一阶段产品改进路线

**作者：** Manus AI  
**日期：** 2026-08-24  
**依据：** 当前 Windows 0.1.6 桌面交付、项目架构说明及 OpenCode、Cursor、Cline、LibreChat、OpenHands、GitHub Copilot Cloud Agent、MCP 与 OpenAI Agents SDK 的官方资料。[1][2][3][4][5][6][7][8]

## 执行摘要

AI Work OS 的核心问题已经从“是否能接入第三方模型”转为“用户能否在一次失败后快速看懂、恢复和审核整条工作流”。当前产品拥有 Direct Provider、Windows SChannel/系统代理兼容、图片传送、混合搜索、项目记忆、GitHub 面板和架构级任务控制面，但这些能力仍分散在不同设置页与运行时模块中。

成熟产品的共同方向不是添加更多模型名称，而是让一个任务具有 **可选能力、可见状态、可恢复执行、可审阅产物和可度量结果**。因此建议先收敛到可靠性、能力卡和可观察工作流，再逐步接入多 Agent、真实 MCP transport 与跨端后台能力。

## 能力矩阵

| 领域 | AI Work OS 当前状态 | 成熟产品基准 | 主要差距 | 建议优先级 |
|---|---|---|---|---|
| Provider 直连 | OpenAI/Anthropic-compatible、MiMo `tp-` 认证、Windows SChannel/系统代理、无密钥诊断。 | LibreChat 自定义端点/恢复流；Cline 的多 Provider 与本地模型；OpenCode 测试过的 provider 目录。 | 连接诊断有了，但没有统一“连接配置—能力—真实请求—恢复建议”的可视时间线。 | P0 |
| 模型能力 | 支持手填和模型目录；MiMo 文本/视觉快捷切换；图片协议载荷。 | Cursor 将模型上下文、推理、工具、视觉与价格/限制明确呈现；LibreChat 以 endpoint/preset 中途切换。 | 缺少可审阅的 capability card、模型级限制、上下文余量与切换历史。 | P0 |
| 流式与会话 | 本地会话账本、历史窗口、复制、跳到最新、50ms 流式节流。 | LibreChat 可恢复流/多端同步；OpenCode 具备撤销/重做；Cline 有检查点和 diff。 | 没有“流中断后恢复、分支、导出/导入、检查点”的用户级闭环。 | P1 |
| 搜索与资料 | SearXNG、Exa、last30days 混合；最多 100 个来源；失败已隔离于 Provider 聊天。 | LibreChat 将搜索、抓取、rerank 和来源作为可见工具活动。 | 检索状态仍偏技术错误；没有来源选择、抓取预览、重试和会话级来源账本。 | P0 |
| 项目记忆 | 可见 `AI_WORK_OS_MEMORY.md`、主人编辑、每轮上下文注入。 | OpenCode `AGENTS.md`；Copilot 自定义说明/记忆；LibreChat 可隔离 Agent memory。 | AI 不能提出可审阅的记忆 diff；无 scope、冲突、过期和 context budget 的用户界面。 | P1 |
| GitHub 协作 | 本地 PAT、状态/差异预览、确认后 commit+push，`/github` 不进入 Provider。 | Copilot 将研究、计划、分支、测试、PR 与日志形成透明链；Cline 使用检查点、diff 与 worktree。 | 缺少计划草案、测试摘要、提交预览、失败恢复和可选 worktree；不应自动 push。 | P1 |
| Agent 执行 | 架构中已有任务、审批、预算、恢复、Adapter/Skill metadata。 | OpenHands 后端切换/ACP；Cline 多 Agent/worktree；OpenAI Agents SDK 的 run、handoff、trace。 | 用户界面尚未把 metadata 接到真实、可取消、可恢复的单工作区任务 run。 | P2 |
| MCP/技能 | 已有 manifest、来源 digest、审查/激活状态等控制面。 | MCP 生态有实际 client/server/tool catalog；Cursor/Cline/LibreChat 提供工具管理。 | 没有真实 MCP transport、工具健康、调用收据和逐工具批准。 | P2 |
| 可观测性 | Provider 最近操作、错误分类、首 token、SearXNG 只读状态、云端构建 provenance。 | LibreChat 的运行追踪/上下文表、Copilot 的 PR 结果指标、OpenAI Agents tracing。 | 缺少统一 run ledger、token/延迟/成功率/模型与检索归因、可导出故障包。 | P1 |
| 跨端与常驻能力 | Tauri Windows 已交付；Web/Android/macOS 仅预留。 | OpenHands 区分本机、容器、VM、云后端；OpenCode 多 client 共享核心。 | 目前不宜先做跨端 UI；应先抽取稳定 DTO、同步模型和产物模型。 | P3 |

## 路线图

### P0：让每次模型与检索请求“看得懂、切得对、失败可恢复”

| 事项 | 用户价值 | 最小验收标准 | 依赖与边界 |
|---|---|---|---|
| **Model Capability Card v1** | 发送图片前即可看见模型是否支持视觉、协议、上下文、流式、工具和联网，而不是等 404。 | 每个 Provider/模型显示已声明、已探测和未知三种能力；视觉任务可一键切至已兼容模型，但不自动替用户更换。 | 先覆盖 OpenAI-compatible、Anthropic、MiMo；不能猜测厂商能力。 |
| **Connection Center v2** | 一次失败可定位为 DNS、代理、TLS、认证、模型、图片、首 token 或流中断。 | 将 probe、stream-test、真实聊天按同一 trace ID 关联；复制的诊断包不含密钥、正文、图片和代理地址。 | 沿用当前 Direct Provider；不增加 Gateway。 |
| **Search Run Card** | 用户知道是 SearXNG、Exa、抓取还是 rerank 失败，并仍可继续普通聊天。 | 每轮搜索显示来源数、失败后端、可重试按钮、发送给模型的来源清单和“未检索仍续发”状态。 | 保持本地 SearXNG 无终端、loopback-only。 |
| **Windows 真实回归矩阵** | 防止安装器再次只在云端通过、在实际网络失败。 | 针对系统代理开/关、MiMo 文本/视觉、SearXNG、长会话、文件和 `/github` 的明确实机通过/失败记录。 | 需主人在 Windows 安装器上执行；不要求提交密钥。 |

### P1：把聊天升级为可审阅的项目工作流

| 事项 | 用户价值 | 最小验收标准 | 依赖与边界 |
|---|---|---|---|
| **记忆提议与上下文预算** | AI 可提出“写入项目记忆”，主人逐段批准，且看见本轮注入了什么。 | `AI_WORK_OS_MEMORY.md` 旁显示 diff、来源会话、scope、过期与 token 预算；批准前不写入。 | 继续以可见 Markdown 为事实源。 |
| **会话检查点、分支与导出** | 长任务中可以恢复、比较不同方案、迁移资料。 | 用户可创建 checkpoint、fork 会话、导出 Markdown/JSON；流中断不丢失已收到内容。 | 不保存 API key；导出需明确包含范围。 |
| **GitHub 变更工作流** | 从“给 token”变为“计划—差异—检查—提交草案—主人确认 push”。 | `/github` 打开面板后显示工作区状态、计划文本、测试结果、文件差异和提交信息。 | 保持最终 push 显式确认；不把 PAT 给模型。 |
| **本地用量与运行账本** | 看见每个模型的调用次数、首 token、总延迟、错误与检索贡献。 | 本地可筛选/导出、按 Provider/模型/会话聚合；默认不保存正文。 | 可参考 TokenTracker 的产品形态，不应依赖云端日志。 |

### P2：以单工作区、可取消的真实 Agent Run 接通控制面

| 事项 | 用户价值 | 最小验收标准 | 依赖与边界 |
|---|---|---|---|
| **Task Run Ledger** | 用户不再只能看聊天文本，而能看规划、工具意图、执行、产物、暂停、取消和恢复。 | 每次 run 有 runId、状态机、时间线、可见审批和可重放摘要。 | 先一个本地工作区；不做后台常驻自动执行。 |
| **受控 MCP Client v1** | 可用 MCP 工具而不把 manifest 误当成执行权限。 | Server 健康检查、工具目录、显式逐工具准入、调用参数摘要和结果收据。 | stdio 优先；网络 MCP 必须明确启用。 |
| **Sandbox/Worktree 工程任务** | 代码任务可隔离、比较差异、回滚。 | Agent 只在选定 workspace/worktree 内工作；变更必须可查看、检查并显式合并。 | 先 Git 项目；不自动操作系统范围目录。 |

### P3：跨端、后台与多 Agent 的后续演进

包括 Web/Android/macOS client、ACP 后端选择、多 Agent 任务板、定时任务、语音/3D 人物。这些方向有价值，但应在 P0/P1 的连接、状态、产物和审批语义稳定后开始；否则会放大当前排障与维护成本。

## 不建议立即做的事

不建议以“恢复可用”为理由重新引入普通聊天 Gateway、默认启用无边界后台 Agent、静默切换模型、自动 push、或把 MCP/skill manifest 直接升级成执行权限。成熟产品的共同经验是把能力和运行状态显式呈现，而非通过不可见中间层替用户作决定。

## 许可证边界

后续复用需逐文件核验。Cline/Continue 是 Apache-2.0，OpenHands/LibreChat 是 MIT；Cursor、GitHub Copilot 与 OpenAI Agents SDK 的商业产品或文档仅作行为/设计参考，不能作为代码复制授权。[2][3][4][5][6][8]

## 参考资料

[1]: https://opencode.ai/docs "OpenCode Documentation"
[2]: https://docs.cursor.com "Cursor Documentation"
[3]: https://github.com/cline/cline "Cline Repository"
[4]: https://github.com/danny-avila/LibreChat "LibreChat Repository"
[5]: https://github.com/OpenHands/OpenHands "OpenHands Repository"
[6]: https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent "GitHub Copilot Cloud Agent"
[7]: https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro "Model Context Protocol"
[8]: https://openai.github.io/openai-agents-js/ "OpenAI Agents SDK"
