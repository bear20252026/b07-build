# P6.3：受控构件管理工作流调研

**日期：** 2026-08-20
**状态：** 设计输入已完成。本阶段只实现同步、本地、显式宿主意图与 append-only 审计；不下载制品、不访问网络、不执行安装脚本、不加载构件、不自动更新。

## 设计依据

| 来源 | 关键原则 | P6.3 收敛 |
|---|---|---|
| SLSA Build: Verifying artifacts | Provenance 必须经实际检查才产生安全价值；验证应检查制品摘要、受信任身份和预期字段；未知输入应失败关闭。 | 管理动作显式绑定 component ID、预期 digest、当前 provenance/lock revision 与可信宿主签发者；不满足任一前置条件即拒绝，并记录不可执行拒绝回执。 |
| OpenClaw Plugins | 任意来源安装应经策略、人工确认和检查；`--force`、确认或更新都不能绕过 install policy；警告确认前应重新评估 staged source。 | 不设浏览器或通用 HTTP 的直接管理写接口；本地可信宿主必须重新读取 current revision/digest 后才可推进每个状态。intent 永远不等于安装、加载、激活或更新。 |
| P6.1/P6.2 已有边界 | 管理员租约由可信桌面 issuer 登记与 task/run/capability binding 保护；provenance/lock 已可 fail-closed 隔离。 | 新建独立 `ComponentManagementAuthority`，只接受短时、单用途、component-bound 的 host attestation；不复用管理员租约作为构件升级的泛化权限。 |

> “SLSA uses provenance to indicate whether an artifact is authentic or not, but provenance doesn’t do anything unless somebody inspects it.” — SLSA Build: Verifying artifacts。

## P6.3 契约目标

| 阶段 | 受控输入 | 输出 | 禁止项 |
|---|---|---|---|
| 候选登记 | 可信宿主 attestation + 受限 provenance metadata | candidate provenance revision | 下载、解包、扫描路径、安装 |
| 摘要核验 | 已登记构件 ID + 预期 digest + attestation | `digest-verified` 审计回执 | 重新计算本地文件 hash、网络拉取、修复摘要 |
| 人工评审 | candidate + 相同 digest + reviewer/attestation | reviewed provenance revision | 自动审查、自动通过、撤销恢复 |
| 锁定 revision | 明确 entries + 当前 reviewed provenance digest + attestation | 新 lockfile revision | 自动收集、自动升级、缺失条目补齐 |
| 撤销 | component ID + attestation | revoked provenance revision | 反撤销、重新激活既有 ID |

## 强制不变量

1. 每个管理调用必须来自已登记且 `trusted` 的本地桌面 issuer，且 issuer 只可签发其平台允许的构件管理 attestation。
2. Attestation 与单个 `operationId`、单个 `componentId`、固定 action、短 TTL 和 payload digest 绑定；过期、重放、action 不匹配、digest 不匹配一律拒绝。
3. 每次动作在推进前重新读取当前 provenance/lock；候选被修改、撤销或 lock revision 改变后，旧 intent 不可继续。
4. lockfile 仅由已评审构件显式构成；一次生成只产生新的连续 revision，不会修改旧 revision。
5. Gateway 只接受可信 native host 入口，不提供浏览器 POST；Workbench 仍只读观测、不能发送构件管理意图。
6. 所有成功/拒绝动作均写入 append-only management receipt 账本；回执不包含 URL、路径、制品、许可证全文、密钥或命令。

## 参考资料

[1]: https://slsa.dev/spec/v1.2/verifying-artifacts "SLSA Build: Verifying artifacts"
[2]: https://docs.openclaw.ai/cli/plugins "OpenClaw plugins CLI"

[1] [2]
