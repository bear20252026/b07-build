# P5 可信桌面签发基础与插件/离线模型诊断调研

**作者：** Manus AI

**日期：** 2026-08-20

## 研究结论

下一阶段应把管理员租约的“签发”与 Web Workbench、普通 loopback HTTP、任务 intent 解码严格分离。当前 P4 的租约账本和 `AuthorityCapabilityPolicy` 已能验证 task/run/capability 绑定、15 分钟上限、撤销与过期；缺口是一个经可信宿主身份确认后才可调用的签发端口。这个端口不应直接运行 Shell、启动插件或泄露 secret，而应只返回脱敏、短时、不可扩权的租约 metadata。

| 参考项目/资料 | 可采纳原则 | 本项目的实施约束 |
| --- | --- | --- |
| OpenClaw 安全文档 | 单一受信操作者边界、loopback 默认、身份先于 scope、插件显式 allowlist、日常审计走冷路径且不加载插件 runtime。 | 当前个人单用户工作站可采用单一 owner 语义，但不把 session ID/窗口标签/HTTP body 当作身份令牌；插件诊断分为纯 manifest 冷审计与明确授权的深度审计。 [1] [2] |
| DeepSeek-Harness | 模型、工具、技能、会话、沙箱、存储、循环、调度、UI 都可作为插件重新组合；运行可由 append-only event stream 追溯。 | Runtime Preset 只能组合已经审核的 metadata，不自动 mount/load/start 任意组件；本项目的 trajectory 继续不保存 prompt、reasoning、secret 和可重放副作用。 [3] |
| ClawCode Rust | 权限模式、`allowedTools`、插件生命周期、local OpenAI-compatible endpoint、状态/doctor JSON 和确定性 mock parity harness。 | 把“可信桌面签发器已配置/未配置、租约状态、插件/模型诊断”做成机器可读只读状态；每一个 allow/deny/expired/revoked 都需可重复测试。 [4] |
| Jan | 本地模型、云 Provider、OpenAI-compatible 本地 API 与 Tauri/Rust/Desktop 结构可共存，但产品强调用户对隐私和模型执行位置的控制。 | 保持本地 endpoint registry 的 loopback-only 规则；诊断只呈现 offline、health、model IDs、Profile 容量和边界，不下载/启动模型。 [5] |
| AnythingLLM | Agent 由预置工具、自定义工具、MCP 和 Agent Flow 组成；文件系统工具默认无目录权限且需显式授予 scope。 | 将 Plugin/Skill/Adapter/MCP 视为同一 capability 生态；未安装、未审核、未激活或 scope 不匹配的条目只显示为诊断，不能因 preset 或 authority mode 自动连接。 [6] |
| Cherry Studio | 桌面端统一管理云与本地 Provider，提供 MCP、插件、文档、主题和跨平台体验。 | Workbench 只聚合 Provider/Plugin/Authority 的只读状态和解释，不直连文件系统、Provider endpoint、DB 或 desktop IPC。 [7] |

## 推荐 P5 最小契约

### 1. 可信桌面签发器端口

在 Agent Runtime 定义 `AdministratorLeaseIssuer`，但不提供读取环境变量、密码、浏览器表单或 OS API 的实现。该端口只接受已经过宿主验证的 `TrustedDesktopLeaseRequest`，并被一个 `TrustedDesktopLeaseIssuerGuard` 二次收紧。

```ts
issue({
  issuerId,          // 经过登记的桌面宿主身份，不是 renderer window label
  operatorId,        // 由宿主确认，不能由 HTTP body 自称
  taskId, runId,
  allowedCapabilities,
  reasonDigest,
  issuedAt, expiresAt,
}) => AdministratorAuthorityLeaseV1
```

硬性规则：issuer 需在 allowlist 登记；租约仍仅限一个 task/run；`allowedCapabilities` 必须是既有 Profile 和 manifest capability ceiling 的子集；无验证器、重复签发、不可信时钟、审计账本错误均失败关闭；返回值无 secret、无任意命令、无路径、无 bearer token。

### 2. 冷路径插件与 Provider 诊断

新增只读 `ControlPlaneDiagnosticReportV1` 聚合已存在的 extension manifest/activation plan/doctor、Skill Pack、Agent Adapter、Audited Scheduler、Provider Profile 与 Local Model Health registry 的**状态计数和脱敏条目**。它不加载 plugin runtime、不 probe 新端点、不激活 profile、不执行调度，也不读 credential reference 的目标 secret。该模式对应 OpenClaw 的默认冷审计思路。[2]

诊断项目应包括：manifest 版本/状态、是否已审核/已激活、每项 capability、当前阻断码、Provider 的 local/offline/health 状态、是否存在锁定的 authority scope；严禁输出 endpoint URL、文件路径、operator、reason 正文、lease ID、credential reference 或任何审批 token。

### 3. Workbench 投影

工作台只显示诊断摘要、authority mode 与空状态/错误状态。管理员租约签发不提供浏览器控件；未来可信桌面壳可以读取 issuer readiness，并在 OS 原生验证通过后调用其独立本地 IPC 端口。普通 Web 模式继续将 admin 显示为“需要可信桌面宿主”。

## 明确不做

本阶段不引入 Electron/Tauri 二进制、不启用 background daemon、cron 轮询或自动 Provider 探测，不下载模型、不连接外部 MCP、不自动安装/激活插件，不把 `admin` 变为隐私、批准、审计、预算、workspace 或 host isolation 的绕过开关。

## 参考资料

[1]: https://docs.openclaw.ai/gateway/security "OpenClaw — Gateway Security"
[2]: https://docs.openclaw.ai/cli/security "OpenClaw — CLI Security Audit"
[3]: https://deepseek.com/harness/en/ "DeepSeek Harness — Everything is a plugin"
[4]: https://github.com/ultraworkers/claw-code/blob/main/rust/README.md "Claw Code — Rust Implementation"
[5]: https://github.com/janhq/jan "Jan — Open-source ChatGPT replacement"
[6]: https://docs.anythingllm.com/agent/overview "AnythingLLM — AI Agents"
[7]: https://github.com/CherryHQ/cherry-studio "Cherry Studio"

## 最终实施契约

P5 拆为两个相互独立但可组合的积木。

### A. Trusted Desktop Lease Issuer Foundation

`TrustedDesktopIssuerRegistry` 是一个只登记 host metadata 的 append-only control plane；它不读取操作系统、环境变量、浏览器或 secret。每个 issuer 有稳定 `issuerId`、显示名、平台标签、状态与 revision。只有 `trusted` 状态的 issuer 能传入 `TrustedDesktopLeaseIssuer`。

`TrustedDesktopLeaseIssuer.issue()` 接受一个由未来桌面主进程完成身份验证后的 `VerifiedDesktopLeaseRequest`。此接口将请求再收紧为：单一 task/run、有效 capability、SHA-256 reason digest、15 分钟内 expiry、issuer 状态为 trusted、目标 capability 需存在于 caller 传入的 capability ceiling。通过后才委托 P4 的 `AdministratorAuthorityLedger.issue()`。

本阶段**不实现宿主身份验证本身**，不提供 HTTP 路由、不提供 Workbench 交互按钮、不把 Desktop Bridge 读命令扩展为写命令。这是为 Electron/Tauri/native host 后续接入留下安全端口，而非伪造认证。

### B. Control Plane Cold Diagnostic Report

`ControlPlaneDiagnosticReportV1` 是 Gateway 层的只读 DTO 工厂，按固定顺序汇总：

1. Extension manifest 的 `id/kind/status/revision/dataBoundary/declaredCapabilities` 与 Extension Doctor `severity/code`；
2. Skill Pack `id/status/revision/declaredCapabilities`；
3. Agent Adapter `id/status/revision/declaredCapabilities`；
4. Audited Schedule `id/status/revision/declaredCapabilities`；
5. Provider Profile 的 `id/status/revision/dataBoundary/driverIds` 与 Local Model Health 的 `id/offline/status/modelIds`；
6. Trusted Desktop Issuer 的 `issuerId/platform/status/revision`；
7. Authority capability 的可用性摘要：`adminIssuance` 固定为 `trusted-desktop-host-required`，普通 Gateway 不可签发。

报告禁止输出 source locator、entry ref、endpoint URL、credential reference、reviewer/operator、note/reason 正文、lease ID、计划 ID、task/run ID、secret、token 或任何执行入口。它不可调用 `plan()`、`activate()`、`probe()`、`connect()`、`run()`、`spawn()`、`issue()` 或数据库写操作。

HTTP 仅新增 `GET /api/control-plane/diagnostics`。任何其他 method 或路径继续由 router 返回 404。Workbench 客户端采用严格 DTO guard，渲染一张只读“Control Plane Diagnostics”卡片，不轮询、不执行 remediation、不触达 Provider/DB/Desktop Bridge。
