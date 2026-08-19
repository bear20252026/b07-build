# v0.17.1：Skill Pack 与知识上下文治理

**日期：2026-08-19**  
**范围：受控扩展平面 v0.17.1**

本版本将项目内的技能视为**可审查的纯文本上下文包**，而非可执行插件、模型指令的自动来源或权限凭据。实现位于 `@awo/knowledge-workflow`，其核心由 `SkillPackRegistry`、追加式 `SkillPackStore`、`SkillPackContextInjection` 与 `KnowledgeWorkspaceService.citeSkillPackContext()` 组成。

> Skill Pack 的登记、审查或发布只改变其可引用状态；它不会下载文件、加载模块、启动进程、读取凭据、调用工具或改变 capability policy。`canAuthorize: false` 与 `canGrantCapabilities: false` 是所有注入对象的固定契约。

| 控制点 | 实现 | 结果 |
| --- | --- | --- |
| 来源可追溯 | `source.type`、`locator` 与 SHA-256 `digest` 固化在每个 revision。 | 发布前必须以人工提供的摘要再次核验。 |
| 发布前审查 | `candidate → reviewed → published` 状态机。 | 候选、审查中、停用或撤销的 pack 不能进入上下文。 |
| 最小上下文 | 调用方必须显式传入 `packIds`；装配器不会按名称、相似度或默认规则挑选 pack。 | 计划中固定输出 `implicitSelection: false`。 |
| token 预算 | 每个 pack 同时记录估算 token 与注入上限，装配时计入总预算。 | 超预算的候选会附带 `over_token_budget` 原因而被省略。 |
| 范围隔离 | 可选 `workspaceIds` 与 `agentIds` allowlist。 | 范围外请求只得到审计性 omission，不会获取正文。 |
| 撤销路径 | 注入记录含 `packId`、revision 和 `verifyAtUse: true`。 | 模型调用前须执行 `assertInjectionCurrent()`；停用、撤销或 revision 漂移均阻断旧注入。 |
| 引用解释 | 知识服务返回独立 `WorkspaceSkillPackCitation`。 | UI/审计可显示 pack、版本、摘要、token 与不可授权标志，且不把它伪装成知识文档 citation。 |
| 浏览器数据边界 | `/api/skills/packs` 返回 manifest summary。 | `content` 正文在创建、状态操作和列表响应中均被服务端移除。 |

## 状态机

| 当前状态 | 可变更为 | 说明 |
| --- | --- | --- |
| `candidate` | `reviewed`、`revoked` | 新登记 pack 不可注入。 |
| `reviewed` | `published`、`revoked` | 只有 digest 一致时才允许发布。 |
| `published` | `disabled`、`revoked` | 已发布仅代表可作为显式文本上下文候选。 |
| `disabled` | `published`、`revoked` | 重新发布仍要复核 digest 与审核者。 |
| `revoked` | 无 | 撤销是终态，防止静默复活。 |

## HTTP 控制面

本地网关增加以下受控 metadata 路由。它们与 Extension Registry 使用同样的服务端时间戳与状态机，而不是让工作台直接接触 SQLite。

| 方法与路径 | 用途 | 正文暴露规则 |
| --- | --- | --- |
| `GET /api/skills/packs` | 列出最新 Skill Pack 审计摘要。 | 不返回 `content`。 |
| `POST /api/skills/packs` | 登记纯文本候选。 | 响应不返回 `content`。 |
| `POST /api/skills/packs/:id/review` | 记录审核者与审查说明。 | 响应不返回 `content`。 |
| `POST /api/skills/packs/:id/publish` | 使用 `verifiedDigest` 核验后发布。 | 响应不返回 `content`。 |
| `POST /api/skills/packs/:id/disable` | 停用当前 pack。 | 响应不返回 `content`。 |
| `POST /api/skills/packs/:id/revoke` | 终态撤销。 | 响应不返回 `content`。 |

## 验证记录

| 验证 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过。 |
| Skill Pack 专项测试 | 5/5 通过，覆盖状态机、digest、范围、预算、incognito、撤销、SQLite 防御性副本和 citation。 |
| 网关 HTTP 生命周期 | 通过。候选、review、publish 与 list 均正常，且测试正文没有出现在任何返回体。 |

该设计为后续外部 Agent 适配提供了一条安全的上下文供给通道：适配器只能接收经过显式引用、范围检查、预算约束和撤销验证的文本，不会因收到 Skill Pack 而获取执行能力。
