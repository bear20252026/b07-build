# AI Work OS 全仓代码审查与参考项目对标路线

**作者：Manus AI**

**审查日期：2026-08-19**

**审查基线：** `main` 的 `26a0bcc`，并包含本次审查中已完成的 Rust Clippy 兼容修复。

## 执行摘要

本次审查覆盖仓库全部自有生产与测试源码，共 **107 个源文件**：90 个 TypeScript、10 个 TSX、5 个 Rust、2 个 Python 文件；不包含依赖目录、构建产物、参考镜像或非运行时资料。整体结论是：项目已经具备清晰的 **Protocol → Domain Control Plane → Infrastructure Adapter → Gateway DTO → Workbench** 依赖方向，且此前引入的架构适应度检查正在有效阻断反向依赖和路由层基础设施泄漏。

> 当前的主要问题不是“层次混乱”，而是系统已从骨架期进入 **受控执行接合期**：若继续增加功能而不先补齐生命周期、资源限制、端到端契约和可观察性，复杂度会集中在大控制面文件和网关边界处。

| 审查维度 | 结论 | 证据 |
| --- | --- | --- |
| 分层与依赖方向 | **通过** | dependency-cruiser 巡检 118 个模块、288 条依赖，未发现循环或禁用的反向依赖。 |
| 类型与单元回归 | **通过** | TypeScript 严格检查；106/106 测试通过。 |
| Workbench 生产构建 | **通过** | Vite 生产构建完成。 |
| Rust 质量门 | **通过** | format、check、test（9/9）与 `clippy -D warnings` 均通过。 |
| Python sidecar 基线 | **通过** | `compileall` 通过。 |
| 已知高优先级缺口 | **存在** | Gateway 关闭资源遗漏；Extension Host 预算未由 OS 强制；阻塞式 lifecycle 读取；尚无 CI workflow。 |

## 已立即修复

Clippy 首次执行指出 `SidecarSupervisor` 有显式 `new()` 但未实现 `Default`。这不是安全漏洞，但会阻断严格 Rust lint 门。本次已在 `crates/process-supervisor/src/supervisor.rs` 补充 `Default` 并委托既有 `new()`，不改变任何进程启动、关闭或监督行为。修复后 Rust Clippy 已以 `-D warnings` 通过。

## 分层审查结论

| 层 | 当前优势 | 需要继续收紧的点 |
| --- | --- | --- |
| 协议层 | `@awo/protocol` 对事件版本、字段与能力进行严格验证，任务回放身份明确。 | 为 HTTP DTO 引入同样的版本化 schema，减少 Gateway route 中浅层手写断言和 `as unknown as`。 |
| Domain Control Plane | Extension、Profile、Skill Pack、Adapter、Schedule 都以 append-only revision 与不可授权契约实现。 | Agent Adapter（829 行）、Skill Pack（585 行）、Scheduler（515 行）仍混合 DTO、guard、in-memory store、SQLite store 与业务服务。 |
| Infrastructure | 通用 SQLite adapter 已迁入 `infrastructure/sqlite`，WAL/追加账本语义明确。 | 缺少统一 migration/version/backup-recovery runner；部分领域聚合仍把 SQLite 类和业务规则放在同一实现文件。 |
| Gateway | 已拆为 14 行入口、207 行 composition root、40 行 router 与六个能力 route；UI 不直连数据库。 | `close()` 漏掉 6 个已构造 SQLite store；各 route 尚无自动化 HTTP 契约集成测试。 |
| Workbench | 使用专用只读 HTTP client，Extension Center 不暴露 install/load/execute/secret 能力。 | 顶层 `App.tsx` 仍使用全局单例 client 与 `document.querySelector` 聚焦；缺少组件级交互、无障碍与错误态测试。 |
| Rust Supervisor | 绝对路径、清空继承环境、版本化 lifecycle IPC、身份匹配、启动期限和关闭回收已存在。 | 实际 memory/CPU 限额尚只以环境变量传入；stdout `read_line` 在 Mutex 内可无限阻塞。 |

## P0：必须在接入真实受监督执行前完成

| 建议 | 发现依据 | 推荐改造 | 参考方向 |
| --- | --- | --- | --- |
| **补齐 Gateway 资源关闭** | `gateway-application.ts` 构造了 SkillPack、三个 Adapter 和两个 Schedule SQLite store，但 `close()` 只关闭 task/knowledge/receipt/subtask/MCP/extension/provider store。 | 关闭 `skillPackStore`、`agentAdapterManifestStore`、`agentAdapterSessionStore`、`agentAdapterMailboxStore`、`scheduleManifestStore`、`scheduledRunStore`；为重复 close 写测试。 | 本地优先 Gateway 应具备显式生命周期管理。[1] |
| **将 Extension Host 预算变成真正限制** | Rust Host 当前把 max memory/CPU 写进环境变量，但没有 cgroup、Job Object、rlimit 或 watchdog 强制执行。 | 先将字段改名为 `requestedBudget` 或实现平台 adapter：Linux cgroup v2、Windows Job Object、macOS 可观测软预算；缺少强制器时不得宣称硬隔离。 | ClawCode 的 Rust harness/doctor 模式适合作为监督层对照。[2] |
| **消除 Extension Host 的无限阻塞 IPC** | `read_lifecycle_response()` 持有 `Mutex` 并调用阻塞 `BufRead::read_line`，外部进程不返回时可阻塞 health/shutdown/poll。 | 使用带 deadline 的非阻塞 read、独立 I/O worker + channel，或在连接层实现超时；所有 error/timeout 都必须 kill/wait/reap。 | OpenClaw Gateway 的集中控制面和 DeepSeek 的可追溯 run 模式都要求生命周期状态可观测。[1] [3] |
| **新增 GitHub Actions 质量门** | 当前 `.github/workflows` 为空，质量门只能人工运行。 | 在 PR/main push 执行 architecture check、typecheck、test、Workbench build、Rust fmt/check/test/clippy 与 Python compile；分缓存的 Node/Rust job。 | Chatbox、AionUi、Cherry Studio 都有成熟多平台质量配置与测试目录。[4] [5] [6] |

## P1：下一开发迭代应完成

| 建议 | 当前缺口 | 可落地设计 |
| --- | --- | --- |
| **Gateway HTTP 契约测试** | 当前 106 个测试覆盖领域对象，但 `apps/runtime-gateway` 没有自动化路由生命周期测试。 | 使用隔离临时 SQLite + `fetch` 编写 route test：非法 DTO、incognito 拒绝、digest mismatch、approval idempotency、关闭后可重启；为 Workbench client 同步生成契约 fixture。 |
| **版本化 HTTP schema** | route 内有大量 `Record<string, unknown>` 和浅层类型断言，嵌套字段可能只在控制面更深处失败。 | 在 `packages/protocol` 增加 HTTP request/response schema；Gateway decode 一次，route 收到已校验 command；Workbench client 复用 response decoder。 |
| **拆分三个大型控制面** | Adapter/Skill/Scheduler 分别混合 schema、guard、store、service。 | 每个模块稳定拆为 `types.ts`、`guards.ts`、`stores.ts`、`control-plane.ts`；SQLite 移入 infrastructure；根级 facade 保持 API 兼容。 |
| **统一 run trajectory** | 任务事件、extension plan、skill citation、adapter session、schedule run 是可审计的，但分散在不同账本。 | 定义 `RunTrajectoryEventV1` envelope，关联 task/run/actor/source/revision/context budget；允许 timeline、resume、fork 和 provenance 查询，不授予权限。 |
| **数据库迁移与恢复演练** | SQLite schema 由各 store 自行 `CREATE TABLE IF NOT EXISTS`；未见统一 schema migration、备份校验或恢复演练。 | 引入 per-store schema version + migrator、导出/校验/恢复命令、损坏数据库只读诊断；确保 append-only revision 在升级后可回放。 |

## P2：产品能力与 Workbench 可用性

| 建议 | 价值 | 对标来源 |
| --- | --- | --- |
| 统一多 Agent 任务板与审批收件箱 | 将 Adapter mailbox、Schedule inbox、Extension doctor 和 Task DAG 显示为同一可筛选运行视图；每个 agent/run 保持独立 context、预算、审批。 | AionUi 的 leader/teammate、async mailbox、task board 与独立 permission dialog。[5] |
| Provider 能力画像扩展 | 在现有 Provider Profile 上增加 embedding、reranker、vision、tool/structured-output、context window、local-health 画像；决策解释显示在 UI。 | AnythingLLM 动态路由与多模型/向量适配；Cherry/Jan 的 local/cloud provider 并存。[7] [6] [8] |
| Knowledge ingestion job 化 | 将摄取从同步 route 转为可重试、可取消、可计量的 collector job，并让 citation 显示 ingest revision。 | AnythingLLM 的 collector/server/frontend 分离和 Jan 的本地优先模型经验。[7] [8] |
| Workbench 组件测试与无障碍 | 用 React Testing Library/Playwright 覆盖审批按钮、错误态、刷新、快捷键、键盘焦点、窄屏；将 `document.querySelector` 改成 ref。 | Chatbox 的 renderer/preload/shared 分层和多平台 UI 测试取向。[4] |

## P3：受控桌面化与生态能力

后续可评估桌面壳，但不应先于 P0/P1。建议采用 Chatbox 的 `main / preload / renderer / shared` 分层，或 Jan 的 Tauri/Rust/extension 分层；所有 preload 或本地 API 必须是细粒度 allowlist。对本地 OpenAI-compatible endpoint 的支持可以扩展，但仍必须遵守 Provider Profile、loopback 验证与 `local-only` 数据边界，不能因 `localhost` 而自动提升信任等级。[4] [8]

DeepSeek Harness 的“Everything is a plugin”值得作为**产品组装模型**而非无条件执行模型：未来可以增加 Runtime Preset，显式选择 model/tool/skill/session/storage/sandbox/loop 的已审核组合；但每项 capability 的执行权仍需由 Rust Host、实时 policy、预算和人工审批单独授予。[3]

## 推荐实施顺序

| 里程碑 | 交付物 | 完成条件 |
| --- | --- | --- |
| R1：生命周期硬化 | Gateway close 完整性、Extension Host deadline/reap、真实/诚实的资源预算语义、CI。 | 可反复启动关闭，无 SQLite handle 泄漏；CI 全绿。 |
| R2：契约与测试 | HTTP schema、Gateway integration suite、Workbench component/a11y tests。 | 所有 DTO 版本化；关键拒绝/审批流程端到端可回归。 |
| R3：运行轨迹 | Trajectory envelope、投影查询、统一任务板。 | 每个 run 可从 task 到 adapter/schedule/skill provenance 追踪。 |
| R4：模块内部解耦 | 三个大控制面 types/guards/stores/control-plane 拆分；迁移器。 | 文件职责稳定，SQLite 不再与业务规则共置。 |
| R5：受控桌面化 | Tauri/Electron 评估、受限 bridge、offline health UX。 | Desktop API 通过最小 allowlist；无 UI 直连 filesystem/shell/provider。 |

## 参考资料

[1] [OpenClaw Repository README](https://github.com/openclaw/openclaw)

[2] [ClawCode Repository README](https://github.com/ultraworkers/claw-code)

[3] [DeepSeek Harness Official Overview](https://deepseek.com/harness/en/)

[4] [Chatbox Repository README](https://github.com/chatboxai/chatbox)

[5] [AionUi Repository README](https://github.com/iofficeai/aionui)

[6] [Cherry Studio Repository README](https://github.com/CherryHQ/cherry-studio)

[7] [AnythingLLM Repository README](https://github.com/Mintplex-Labs/anything-llm)

[8] [Jan Repository README](https://github.com/janhq/jan)

[9] [LobeHub Architecture Documentation Route](https://lobehub.com/docs/development/basic/architecture)
