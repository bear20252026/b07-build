# AtomCode 公开架构核查笔记

**来源仓库**：`https://github.com/atomgit-atomcode/atomcode`
**核查日期**：2026-08-19
**使用边界**：仅提炼公开、可验证的架构原则与行为模式；不复制来源不明或未授权材料。

## 核查结论

用户随后提供的 `atomgit-atomcode/atomcode` 是实际活跃的公开代码仓，而先前的 `bbylw/atomcode` GitHub 仓更接近展示页。当前主仓公开页面显示其使用 MIT 许可证、拥有完整 Rust 工作区、版本 v5.0.7 的近期提交以及持续开发的历史。

| 公开可见能力 | AtomCode 的高层做法 | 对 b07-build 的独立实现含义 |
|---|---|---|
| Agent loop | 多步工具调用、验证回路、步数预算、重复调用检测与结果数据日志。 | 为 `agent-runtime` 增加有界执行、停止条件、错误作为 observation 与可回放事件。 |
| 运行时边界 | Agent loop 经 command/event channel 与 TUI 分离，核心可被 CLI、TUI、daemon 复用。 | 保持 UI 只订阅事件；将计划、上下文和工具编排封装在可替换 TS 运行时端口中。 |
| 权限与工具 | 破坏性命令、敏感路径、工作区外访问均需要显式确认；工具失败回传为 observation。 | 基于现有 `CapabilityPolicy` 增加路径/操作风险解析和审批门控，而不是只按工具名授权。 |
| 上下文治理 | token 预算窗口、按 turn 的历史保留、冷/热信息分层、工具结果外置和摘要。 | 先实现纯内存的上下文预算器：按消息/结果代价选择保留、摘要或截断，不耦合 provider。 |
| 会话恢复 | 持久化会话和 resume；近期提交强调会话存储可靠性。 | 事件日志落地前先为上下文与执行运行提供可序列化快照接口，后续接 SQLite。 |
| Hooks / 扩展 | 公开提交描述了工具前后、回合和会话级扩展点，以及允许修改或拒绝。 | v0.4 后加入受控 Hook port：只接收结构化决策，默认不得绕过 `CapabilityPolicy`。 |

## 推荐本轮切片

下一批代码优先实现 `ContextBudgeter` 与 `ExecutionBudget` 两个独立运行时积木：前者在调用模型前按预算挑选上下文，并以结构化的 `context.compacted` 事件留下审计证据；后者为 Agent loop 统一限制工具步数、重复调用和超时。两者都只依赖 `protocol`，不触达模型、窗口、数据库或 sidecar。

## 公开来源

- https://github.com/atomgit-atomcode/atomcode
- https://raw.githubusercontent.com/atomgit-atomcode/atomcode/main/README.md
- https://github.com/atomgit-atomcode/atomcode/blob/main/LICENSE

## AtomCode 主仓与 Claude Code 官方资料补充

经用户更正，`atomgit-atomcode/atomcode` 是应作为主要参考的公开仓。其公开页面显示 Rust 工作区目录（包括 kernel、capabilities、coding、review、TUI、CLI、daemon 等边界）、MIT 许可证与持续发布历史。公开的架构/提交说明强调按 turn 管理上下文、工具结果外置、热/冷上下文分层、重复调用与过度验证检测、结构化数据日志，以及工具前后的 Hook 扩展点。

Claude Code 官方文档提供了两条对 b07-build 尤其重要的可迁移原则。第一，权限规则由运行时强制执行而非由提示词保证，采用 deny → ask → allow 的优先顺序，且在复合命令中应逐条子命令判断。第二，Hook 是生命周期中的确定性扩展点；`PreToolUse` 可以阻止调用，但 Hook 不应成为绕过权限策略的路径。其公开 Hook 生命周期还将 Session、Turn、Tool、Subagent、Compact 与 Session End 等事件拆开，这适合 b07-build 后续的事件化运行时。

| 设计结论 | 本轮拟落地点 |
|---|---|
| Context 应以预算和可回放决策管理，而不是直接截断字符串。 | 新增纯领域 `ContextBudgeter`：排序选择、超额压缩清单和 `context.compacted` 事件。 |
| 每次执行都有全局次数/重复调用上限。 | 新增纯领域 `ExecutionBudget`：针对调用总数和工具指纹重复数进行默认拒绝。 |
| Hook 可以阻断或记录，但不能放宽权限。 | 为受控执行器增加可选 `PreToolUse` / `PostToolUse` port；策略与审批仍在 Hook 之前。 |

### 新增公开来源

- https://github.com/atomgit-atomcode/atomcode
- https://raw.githubusercontent.com/atomgit-atomcode/atomcode/main/README.md
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/hooks

## OpenCode 公开设计补充

OpenCode 应作为本轮首要公开工程参考。其官方文档明确区分 primary agent、subagent 与自动压缩/摘要系统 agent；每个 agent 都可以拥有独立模型、提示词、最大步骤数和权限。Plan agent 将编辑与 shell 操作设为 `ask`，Explore/Scout 等子 agent 则保持只读，这验证了“任务角色与工具权限必须绑定”的设计方向。

其权限文档将行为分为 `allow`、`ask`、`deny`，覆盖工具、外部目录、子 agent 与相同调用重复三次的 doom loop。该模型提供了两个适合 b07-build 的直接原则：一是执行预算应在真正调用工具前阻断重复操作；二是 agent profile 的权限只能收紧默认能力，不能依赖提示词自我约束。

### 资料边界更新

`reference/ClaudeCode_静态补全候选_20260818.zip` 的仓库索引明确标注为“社区泄露镜像/静态补全候选”。本轮只读取其索引和归档清单，不解压、不执行、不引用其中任何实现；其可用价值仅限于与公开 Claude Code 官方文档相互印证的高层工程问题清单。

### 新增公开来源

- https://github.com/anomalyco/opencode
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/tools/
