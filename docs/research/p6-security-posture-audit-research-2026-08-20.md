# P6.1：Security Posture Audit 研究与契约

**作者：Manus AI**

**日期：2026-08-20**

## 参考结论

OpenClaw 的安全审计将问题输出为稳定的结构化 `checkId`、severity 和可操作说明，并将审计与自动修复分开；部分深度检查需要主动探测，不应与普通冷路径审查混同。[1] 其安全文档也强调在本地个人助手场景中，认证、作用域与硬边界必须优先于对模型行为的信任。[2]

本项目的 P6.1 只采纳**结构化、可重开、默认无副作用的审计模型**。它不会模仿远程网关、消息通道、外部凭据扫描、网络扫描、插件代码执行、实时模型 probe 或自动修复，因为这些能力尚未在当前 AI Work OS 的受控产品面中存在，或会扩大审计本身的攻击面。

## P6.1 审计契约

| 项目 | 设计约束 |
|---|---|
| 审计入口 | `SecurityPostureAuditService.inspect()` 仅消费已经持久化的 registry/profile/health/issuer metadata 和调用方明确提供的恢复/资源隔离声明。 |
| 输出 | `SecurityPostureReportV1`，包含 schema version、audit ID、检查时间、排序稳定的 `SecurityFindingV1[]` 和 `canExecute: false`。 |
| Finding | 仅含 `checkId`、severity、subject kind/id、evidence digest 与固定 remediation hint；不含 endpoint、locator、凭据、reason 正文、文件路径或任意命令。 |
| 审计类别 | `input.provenance.*`、`extensions.*`、`providers.*`、`local-models.*`、`issuers.*`、`recovery.*`、`resource-isolation.*`。 |
| 默认行为 | 缺少 evidence 产生 warning，而不是假设健康；审计永不自动修复、加载 extension、探测 endpoint、创建 recovery bundle、签发租约、改写 Profile 或执行命令。 |
| 复查 | 同一输入证据集产生稳定、排序一致的 report；未来 append-only audit ledger 可以把 report digest 追加为审查记录，但普通浏览器 GET 不应以写数据库作为副作用。 |

## 首批检查

| Check ID | 条件 | severity | 说明 |
|---|---|---|---|
| `input.provenance.taint-gate-required` | 声明可处理 external/derived 内容的 Profile 不是 Reader 或不存在 taint gate 证据 | warning | P6.0 必须继续作为 task runtime 的固定收紧层。 |
| `extensions.unreviewed-or-revoked` | extension 为 discovered/revoked，或 doctor 返回 warning | warning | 未审查/撤销构件不应出现在可用 activation 组合。 |
| `providers.unavailable-or-weak-boundary` | active Profile 非 local-only，或无 active profile | warning | 仅报告 data boundary 需求，并不修改 Provider Profile。 |
| `local-models.unhealthy` | 已登记本地模型 offline/unhealthy | warning | 使用既有 health metadata，不触发 probe。 |
| `issuers.untrusted` | issuer 不是 trusted | info | 管理员租约当前仍必须失败关闭，浏览器不能签发。 |
| `recovery.drill-missing` | 调用方没有提供最近的恢复演练证明 | warning | 审计不创建 bundle 或启动演练。 |
| `resource-isolation.requested-only` | 请求资源隔离但 OS enforce evidence 不存在 | warning | UI/审计不得把 requested-only 表述为强制隔离。 |

## References

[1]: https://docs.openclaw.ai/gateway/security/audit-checks "OpenClaw Security Audit Checks"
[2]: https://docs.openclaw.ai/gateway/security "OpenClaw Gateway Security"
