# P2 调研：本地数据恢复、模块解耦与多 Agent 工作台

**作者：Manus AI**

**日期：2026-08-19**

## 结论

P2 应把“备份文件”升级为可验证的 **恢复包（recovery bundle）**：每个 bundle 记录生成时间、源数据库清单、SHA-256、SQLite `quick_check` 结果与 restore drill 状态。SQLite 官方说明在线备份 API 或 `VACUUM INTO` 才能从运行中数据库获取一致快照；不应以直接复制 WAL 活跃主文件替代一致备份。[1] WAL 的 `-wal`/`-shm` 是持久状态的一部分，且长读事务会导致 checkpoint 饥饿，因此恢复服务应在受控的闲置窗口做导出和验证，而不是在 UI 线程中复制文件。[2]

| P2 模块 | 可迁移实践 | AI Work OS 取舍 |
| --- | --- | --- |
| Recovery Bundle | SQLite 一致快照、digest、quick_check、独立临时目录 restore drill。 | 默认本地导出；不自动上传、替换运行中 DB 或执行调度。导入是未来显式恢复 intent。 |
| Trajectory Board | DeepSeek 的 append-only provenance 与 AionUi 的独立会话状态展示。 | UI 只读显示 task/run/source/审批/风险/时间；不将轨迹按钮变为“重放执行”。 |
| Multi Agent | AionUi 的独立 session、任务板与每 agent 待审批提示。 | 复用本仓 Adapter session、approval mailbox、Run Trajectory；仍保持外部 Agent 不自动启动。 |
| Tool visibility | AnythingLLM 在 agent 会话开始/结束展示与 workspace tool 提示。 | 显示 capability/risk/状态摘要，不显示 credential、tool args/result 或隐式授权。 |

AionUi 的公开说明展示多个独立并行 session、共享任务板与每个 Agent 的独立审批提示。该产品也有 unattended/全权限模式；AI Work OS 只采纳 **可观测性和审批可见性**，不采纳 YOLO、自动执行或共享写入权限。[3]

AnythingLLM 在会话开始/结束提供可见 log，并提示当前 workspace 可用的工具。这支持将“当前运行状态”和“可请求能力”拆为 UI 信息层；但工具可见性不是权限授予，本仓继续以 Profile、policy、budget 与 approval 的服务端判定为准。[4]

## P2 实施边界

1. `RecoveryBundleService` 只导出与验证，输出不可变 metadata；它不在后台定时、上传、覆盖当前数据库或自动恢复。
2. `TrajectoryPanel` 只读消费 `/trajectory`、Adapter mailbox 和 Schedule inbox DTO；它没有 execute、approve 或 credential 接口。
3. 领域模块继续按 `manifest / validation / store / service` 分组，根级 facade 仅维护兼容导出；禁止 UI 导入 SQLite adapter。

## References

[1] [SQLite Online Backup API](https://sqlite.org/backup.html)

[2] [SQLite Write-Ahead Logging](https://sqlite.org/wal.html)

[3] [AionUi Repository](https://github.com/iofficeai/aionui)

[4] [AnythingLLM Agent Usage](https://docs.anythingllm.com/agent/usage/overview)
