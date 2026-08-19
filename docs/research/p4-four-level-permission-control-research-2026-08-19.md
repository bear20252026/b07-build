# P4 四级权限控制与管理员模式调研

**日期：** 2026-08-19
**范围：** 为 AI Work OS 设计 Plan、Approve-each-step、Automate、Admin 四级权限；保持本地优先、默认拒绝、可恢复与可审计架构。

## 结论

“管理员”应代表经操作者显式确认的**短时高权限执行租约**，而不是能无视安全、隐私、身份认证、审计、网络边界或数据隔离的永久 bypass。高权限可以取消常规逐步审批，但不得绕过：身份与本地会话绑定、命令/路径规范化、不可变审计、过期、撤销、资源上限、显式能力清单与默认拒绝。

| 权限级别 | 产品意图 | 运行时行为 | 仍不可绕过的边界 |
| --- | --- | --- | --- |
| `plan` | 只规划与检查 | 仅模型、文档与只读文件能力；写入/网络/命令/浏览器均拒绝 | 默认拒绝、数据边界、审计 |
| `review` | 每一步由操作者审批 | 高影响动作进入审批收件箱；未决、超时或无 UI 均拒绝 | 审批绑定 action/capability/run；审计与预算 |
| `automate` | 在已声明工作区自动完成 | 仅预先批准的受控工作流、能力与预算内自动执行；高风险越界仍拒绝或请求审批 | allowlist、沙箱/路径、预算、审计、撤销 |
| `admin` | 维护窗口内的 break-glass 管理执行 | 在签发的短时、绑定操作者/工作区/能力范围的租约内可跳过常规逐步审批 | 不可绕过认证、deny 规则、审计、过期、撤销、资源限制与秘密不出域 |

## 公开参考项目的可采纳原则

### OpenClaw

OpenClaw 将命令执行权限与执行位置分开，并强调有效策略取较严格层；其 host exec 审批与命令 allowlist、可选人工批准叠加，且批准绑定规范化后的 `cwd`、argv、环境以及（可识别时）文件操作数。其文档明确了 `full`/YOLO 执行面强大，应优先采用 allowlist；并通过安全审计检查高权限、远程暴露、插件加载与配置漂移。[1][2][3]

可借鉴内容：

- 按 capability 和风险而非“万能开关”表达权限；
- 审批/租约须绑定规范化的执行计划与目标，不可在批准后替换命令；
- 安全策略与执行主机策略取更严格值；
- 管理员模式应默认本地、显式进入、短时过期，并有可检查的有效策略快照；
- 高权限模式同样进入安全审计，作为风险态而非隐藏开关。

### AnythingLLM

AnythingLLM 区分单用户与多用户角色，并让桌面文件系统 Agent 默认没有目录访问，需要显式授予特定目录及子目录访问权；容器模式把 host 文件访问限制于绑定卷。[4][5]

可借鉴内容：

- 管理员身份不等于任意文件系统范围；文件与工作区 scope 必须显式声明；
- 默认无目录访问，应用目录/卷/路径白名单；
- 在 UI 中使 Agent 会话和启用工具可见，而不是隐式发生。[6]

### LobeHub、ClawCode、DeepSeek-Harness 的适配方向

在本项目中保留 LobeHub 的工作台可观察性与 Agent 编组方向、ClawCode 的 Rust 进程控制平面、DeepSeek-Harness 的“组件/插件可替换”方向，但将每个插件、外部 Agent adapter 和 sidecar 视为独立 capability 申请者。manifest、激活计划、审批与轨迹均是 metadata，不能以 profile、adapter 或 admin 状态自动启动组件。

## 推荐的实现边界

1. **版本化协议：** 将 `AgentProfileId` 扩展为四级，HTTP contract 严格接受唯一枚举；UI 不可传入任意权限字符串。
2. **权限会话租约：** 新增 append-only `PrivilegeLease` 账本。`admin` 要求专门签发，包含 operator ID、任务/run、workspace scope、allowed capabilities、issued/expiry/revoked 与 reason；不得持久保存 secret。
3. **策略合成：** effective decision = 不可绕过 deny 层 ∩ profile 策略 ∩ 管理员租约（若有）∩ resource budget。管理员租约只可把 `require_approval` 降为 `allow`，不能将 deny 降级，也不能增加未声明能力。
4. **工作区绑定：** 管理员租约绑定单个工作区或显式 `local-maintenance` scope；禁止 wildcard host/network scope。
5. **审计：** 记录 profile 选择、租约签发/撤销/过期、每次基于租约放行的 capability、计划摘要哈希和最终结果；UI 只读展示。
6. **失败关闭：** 租约缺失、过期、scope 不匹配、审计不可用或系统时间不可信时拒绝高风险动作；没有前端时不能默认继续。
7. **自动化：** `automate` 不是管理员模式。它只能运行明确定义、可恢复的任务计划，不能成为定时轮询或后台 daemon 的万能开关。

## 参考资料

[1]: https://docs.openclaw.ai/tools/exec-approvals "OpenClaw — Exec approvals"
[2]: https://docs.openclaw.ai/tools/permission-modes "OpenClaw — Permission modes"
[3]: https://docs.openclaw.ai/gateway/security "OpenClaw — Gateway security"
[4]: https://docs.useanything.com/features/security-and-access "AnythingLLM — Security and access"
[5]: https://docs.anythingllm.com/agent/usage/file-system-agent "AnythingLLM — File System Agent"
[6]: https://docs.anythingllm.com/agent/usage/overview "AnythingLLM — AI Agent Usage"

## 补充调研：插件化与权限上限

### DeepSeek-Harness

DeepSeek-Harness 明确将模型、工具、技能、会话、沙箱、存储、循环、调度和 UI 都作为可替换插件，并以 append-only 会话日志支撑运行轨迹、恢复、分叉和回放。[7] 本项目应保持这一思想，但把每个插件 capability 的**声明、策略评估和审批租约**保留在 Gateway/Rust 监督控制面，而不是由插件自证权限。

### ClawCode

ClawCode 的 Rust 实现提供权限模式、`allowedTools`、工作区写入默认值、会话持久化、MCP 生命周期、插件管理和确定性 mock parity harness；其 README 还将 `bash_permission_prompt_approved` 与 `bash_permission_prompt_denied` 作为可重复验证的端到端场景。[8] 可采纳实践是：对四级权限模型编写 deny/approve/lease-expired/revoked 的确定性测试，并保留 Rust 进程监督的资源隔离与 reap 语义。

### Cherry Studio

Cherry Studio 的企业 Agent 管理说明区分默认权限和最大权限，且在发布前验证 Agent、RAG 与工具。[9] 对应本项目应以“**最大权限上限**”作为 profile 和管理员租约之外的不可绕过天花板：任何管理者不能给某个 Agent、workspace 或外部 adapter 授予超过其已审查 manifest/资源边界的能力。

## 增补实现规则

- plugin、MCP、sidecar、浏览器桥接与远程 adapter 都不得因为选择 `automate` 或 `admin` 自动加载或启动；它们必须已有审核清单、显式激活计划和独立生命周期。
- `admin` 允许跳过的是某一已合法声明能力的**常规逐步人工审批**，不允许跳过 manifest 审查、能力允许范围、资源预算、签名/身份、审计、撤销、网络/工作区 scope 与禁止规则。
- 租约需要“最大权限模式”字段及 hash；后续若改变 profile/工作区/租约字段，必须签发新版本而不是原地改写。
- P4 不新增后台持续执行或 cron 轮询。`automate` 仅表达本次可恢复任务执行的 approval posture；真正的调度仍沿用 Audited Schedule 控制面。

[7]: https://deepseek.com/harness/en/ "DeepSeek Harness — Everything is a plugin"
[8]: https://github.com/ultraworkers/claw-code/blob/main/rust/README.md "Claw Code — Rust Implementation"
[9]: https://docs.enterprise.cherry-ai.com/docs/admin/agent-management/ "Cherry Studio Enterprise — Agent Management"

## 最终架构决定

为了不让“任务角色/资源预算”与“本次执行授权姿态”混为一谈，P4 **保留现有 `AgentProfile`**（Build / Plan / Explore）作为工作负载、上下文和预算约束；新增版本化 `ExecutionAuthorityMode`，在提交任务时独立选择。这样已有 Profile、快照、Provider/Extension 策略和审计数据不会被粗暴重命名，同时满足四级权限产品要求。

| Authority Mode | 语义 | 对 `require_approval` 的处理 | 是否需要租约 |
| --- | --- | --- | --- |
| `plan` | 只计划、只读检查 | 高影响能力直接收紧为 `deny` | 否 |
| `review` | 每一步审批 | 保持 `require_approval` | 否 |
| `automate` | 已明确选择的受控自动完成 | 在合法 capability scope 内转为 `allow` | 否；任务提交本身构成单次明确授权 |
| `admin` | 维护窗口的管理员执行 | 仅在匹配、未过期、未撤销的管理员租约内把 `require_approval` 转为 `allow` | 是 |

### 合成顺序

```text
不可绕过 deny / manifest capability ceiling
  ∩ 基线 CapabilityPolicy
  ∩ AgentProfile（仅能收紧）
  ∩ AuthorityMode overlay
  ∩ AdminLease（仅 admin；仅放行原本 require_approval 的已声明 scope）
  ∩ ExecutionBudget / DAG 状态机
```

**关键不变量：** 若任一前置层返回 `deny`，最终永远是 `deny`。`automate` 与 `admin` 都不能引入新的 Capability、激活插件、读取 credential、脱离已批准工作区，也不能绕过预算、审计、时间过期或撤销。

### 管理员租约的最小字段

```ts
{
  schemaVersion: 1,
  leaseId, operatorId, taskId, runId,
  allowedCapabilities, issuedAt, expiresAt,
  reasonDigest, status: 'active' | 'revoked' | 'expired',
  canOverrideApproval: true,
  canOverrideDeny: false,
  canReadSecrets: false,
  canReplaySideEffects: false,
}
```

管理员租约上限暂定 **15 分钟**，只绑定一个 task/run，不允许 `*` capability 或跨工作区/跨宿主 wildcard。每次权限放行保留 `leaseId` 作为轨迹 metadata。租约在审计账本不可用、到期、撤销、operator/task/run/scope 不匹配时失效并失败关闭。

### P4 变更面

1. Protocol：Authority Mode 与任务提交 HTTP v1 contract；任务事件与 JSON Schema 写入执行权限选择/管理员租约相关的脱敏 metadata。
2. Agent Runtime：可组合 `AuthorityCapabilityPolicy`、租约账本端口、SQLite WAL adapter、默认拒绝的租约校验器与专项测试。
3. Gateway：composition root 注入、受控的本地管理员租约签发/撤销端点、任务创建时由 authority mode 装配策略，所有事件落入 trajectory。
4. Workbench：Authority mode 显式选择与只读租约/有效权限状态；不在 UI 发起任何自动插件加载、端点连接或 secret 访问。
5. Rust Supervisor：不在本阶段改写其 OS 级资源隔离；任何新的高权限执行仍会受现有 cgroup/kill/reap 监督约束。

## P4 实现结果

P4 已实现为独立于 Agent Profile 的 `ExecutionAuthorityMode`。现有 Build/Plan/Explore Profile 继续承担任务形态、上下文与工具预算；执行权限在任务提交、命令回执、可恢复快照、运行时策略和运行轨迹中独立保存。旧 HTTP 客户端及旧 SQLite 快照缺少该字段时固定回退到 `review`，不会默认进入自动或管理员模式。

| 模式 | 当前运行时状态 | 策略结果 |
| --- | --- | --- |
| `plan` | 已启用 | 除模型、文档、工作区只读检查以外的 capability 被收紧为 deny。 |
| `review` | 已启用且为旧客户端默认值 | 保持既有 `require_approval` 逐步审批。 |
| `automate` | 已启用 | 仅把既有 `require_approval` 转为 allow；既有 deny、Profile 边界、预算、DAG 状态和宿主隔离仍然有效。 |
| `admin` | 已实现领域策略与 SQLite append-only 租约账本；普通 Gateway HTTP **默认关闭** | 租约可精确绑定 task/run/capability、最长 15 分钟、支持撤销和到期失败关闭；但浏览器 body 不能充当本地操作者认证，因此普通 HTTP 返回 403。 |

管理员租约的 SQLite 适配器以 revision append-only 方式保存，composition root 将其纳入统一 close 生命周期。`execution.authority.selected` 作为严格的 TaskEvent 进入 trajectory，但只投影 `authorityMode`；不会记录 lease ID、operator、能力列表、维护理由、endpoint 或 credential。

> 下一阶段如需真正启用 `admin`，必须先通过受信任桌面宿主实现本地操作者认证与短时租约签发器。该签发器须独立于浏览器和普通 loopback HTTP，并继续复用现有 DesktopBridgeGuard、Rust 进程监督、租约账本、撤销与 trajectory 管道。它绝不能成为“忽略隐私、安全、审计或默认拒绝”的开关。
