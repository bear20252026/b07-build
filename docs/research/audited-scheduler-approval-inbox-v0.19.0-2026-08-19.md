# v0.19.0：审计调度与审批收件箱

**日期：2026-08-19**  
**范围：受控扩展平面 v0.19.0**

本版本实现 `AuditedScheduleControlPlane`，将周期性任务描述为经审查的 **Schedule Manifest**，并将每个调度窗口表示为拥有独立 `runId` 的、可恢复的 **Scheduled Run Record**。调度控制面只计算到期窗口与生成审计记录；它不启动计时器、后台循环、外部连接、进程、模型调用或工具执行。

> **计划和批准不等于执行。** 每个 run 以及任何审批决议均固定为 `canAuthorize: false` 和 `canExecute: false`。未来运行时若要执行任务，仍必须另行通过实时 capability policy、Profile 限制、预算、审批收据、受控工具执行器和 Rust 监督宿主。

| 控制点 | 实现 | 结果 |
| --- | --- | --- |
| Schedule Manifest | `ScheduleManifestV1` 包含模板摘要、SHA-256 digest、时区、interval、错过运行策略、预算与 approval 标志。 | 不保存命令、密钥、URL、runner 或模板执行代码。 |
| 时区与触发器 | 仅接受有效 IANA `timeZone`，并限制 interval 不得低于 60 秒。 | 高频轮询不能伪装为普通调度记录。 |
| 模板能力审查 | 模板请求 capability 必须来自核心 allowlist。 | 写入、网络、Shell、浏览器能力强制 `requiresApproval: true`。 |
| 生命周期 | `candidate → reviewed → enabled → disabled/revoked`。 | 未启用计划不会生成 run；撤销为终态。 |
| 独立运行 | 每次窗口要求 caller 提供唯一 `runId`，相同 id 对同一 schedule 仅幂等重放。 | 避免重复创建和跨计划复用。 |
| 错过运行 | 记录 `missedSlots`，并仅合并为当前窗口的一条审计 run。 | 不会在恢复时隐式补跑多个历史任务。 |
| 运行预算 | 每条 run 复制创建时的模板、预算、Schedule revision。 | 后续 manifest 变化可被检测，不会静默改变已计划 run。 |
| 审批收件箱 | 高风险 run 进入 `pending_approval`；支持 `approved`、`denied`、`expired`。 | 决议仍只是审计 metadata，不产生执行句柄。 |
| 失效阻断 | 处理 run 决议时复验 Schedule 当前状态与 revision。 | 停用、撤销或更新后的计划不能继续处理既有待决 run。 |
| 可恢复账本 | Manifest 与 run 使用独立 append-only SQLite revision store。 | 支持离线重开、审计和防御性复制。 |

## 状态机

| 对象 | 状态 | 可进入状态 |
| --- | --- | --- |
| Schedule | `candidate` | `reviewed`、`disabled`、`revoked` |
| Schedule | `reviewed` | `enabled`、`disabled`、`revoked` |
| Schedule | `enabled` | `disabled`、`revoked` |
| Run | `ready` | `expired` |
| Run | `pending_approval` | `approved`、`denied`、`expired` |
| Run | `approved`、`denied`、`expired` | 终态 |

## 本地 HTTP 控制面

网关只暴露本地 DTO。`POST /api/schedules/:id/runs` 是显式的窗口规划请求，并不等同于后台调度器；服务端没有注册 interval、cron 或 runner。

| 方法与路径 | 功能 | 执行边界 |
| --- | --- | --- |
| `GET/POST /api/schedules` | 读取或登记 Schedule Manifest。 | 仅审计 metadata。 |
| `POST /api/schedules/:id/review|enable|disable|revoke` | 记录人工状态变更。 | 不创建后台循环。 |
| `GET/POST /api/schedules/:id/runs` | 读取 run 或显式规划当前到期窗口。 | 仅生成不可执行 run record。 |
| `GET /api/schedules/approval-inbox` | 查询待审批高风险 run。 | 无执行入口。 |
| `POST /api/scheduled-runs/:id/approve|deny|expire` | 写入决议。 | 决议不会授予工具权限。 |

## 验证记录

| 验证 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过。 |
| 审计调度专项测试 | 5/5 通过，覆盖审查/启用、runId 幂等、预算防御性复制、错过 slot、高风险审批、失效阻断和 SQLite 重开。 |
| 网关 HTTP 生命周期 | 通过。高风险 Schedule 被 review/enable 后才创建 `pending_approval` run；审批响应保持 `canExecute: false`。验证未启动计时器、后台调度器或任务 runner。 |

本版本将自动化的管理面与执行面清楚拆分。若将来需要真正的周期性运行，应在经过单独部署与用户确认后，让确定性的调度宿主显式调用该控制面，并由运行时再次评估权限、预算和审批，而不能将该控制面直接升级为自动执行器。
