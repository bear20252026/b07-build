# 更正记录 CHANGELOG

<!-- file-id: acct2-20260819-ai-work-os-changelog ; 作者: 账号2 ; 日期: 2026-08-19 -->

> 格式：`## [日期] 变更摘要` → `### 修正（原因→处置）` / `### 新增` / `### 决策`。
> 每次更正都记录**为什么改**（基线：BASELINE.md v0.1.0）。

## [2026-08-19] v0.2.0 参考资料分离归档 + 产品目标/参考库/框架总纲

### 决策
- **参考资料与主代码分离**：新增 `reference/` 目录存放外部参考 zip，**不参与**任何 npm/cargo workspace 构建；主代码仍只在 `packages/ crates/ sidecars/ apps/`。
- **MiMo-Code 镜像策略**：只取上游最新单提交（`git clone --depth 1 --single-branch`），**不追历史**；推送到自建公开仓 `bear20252026/MiMo-Code`（孤儿根提交规避浅克隆推送拒绝）。
- **Antelope 最小版**：本地暂无源码文件，列入参考清单（REFERENCE.md），待取得后再入 reference/。

### 新增
- `reference/CoreCoder_7篇源码导读原文归档_20260819.zip`（50K，CoreCoder 7 篇导读原文）
- `reference/静态补全候选_20260818.zip`（27M，静态补全候选）
- `reference/REFERENCE.md`（参考材料索引 + 使用规则 + 许可证隔离提醒）
- `docs/产品目标参考代码库与整体框架.md`（产品目标/参考代码库含 Claude Code 7 项工程设计基线 + MiMo-Code + CoreCoder + Antelope/整体积木框架/研发优先级）

### 附注
- 参考材料使用遵循上游许可证；写新代码走清洁实现（自己的领域模型/命名/测试），不复制非公开代码。


### 决策
- **pnpm → npm workspaces**：本机未装 pnpm，改用 npm workspaces 串联 `packages/*` 与 `apps/*`，行为等价、零额外安装。
- **Python sidecar 使用项目内 `.venv`**：避免污染全局 Python 3.14.4；fastapi/uvicorn/httpx 仅装在 sidecar 虚拟环境。
- **仓库可见性 = 公开（public）**：用户明确选择，与既有镜像项目公开模式一致。
- **token 命名统一为 `AWO_SIDECAR_TOKEN`**：避免与上游 OpenWorker 的 `COWORKER_API_TOKEN` 混淆（跨项目辨识）。

### 修正
- **`cargo check` 报 "no targets specified"**：`Cargo.toml` 存在但 crate 根缺失（文件命名为 `supervisor.rs` 而非 `lib.rs`）。
  → 处置：新增 `src/lib.rs`（仅 `pub mod supervisor;`，一文件=一作用：crate 根）。
- **`cargo check` 警告 `unused_mut`**：`shutdown()` 中 `let Some(mut child)` 无可变需求。
  → 处置：去掉 `mut`，消除告警；重跑 `cargo check` 确认零警告。
- **Python `ModuleNotFoundError: fastapi`**：全局 Python 未装 fastapi。
  → 处置：`python -m venv .venv` 并安装 fastapi/uvicorn/httpx，端到端测试通过（401/401/200）。

### 新增
- `packages/protocol`：`types.ts`（TaskEvent 7 事件类型）+ `schema/task-event.schema.json`（JSON Schema 唯一事实源）。
- `crates/process-supervisor`：`supervisor.rs`（spawn 注入 env / Windows CREATE_NO_WINDOW / shutdown 回收 / is_alive 健康检查）+ 单元测试。
- `sidecars/document-worker`：`app.py`（FastAPI 路由 + `secrets.compare_digest` 常量时间 token 鉴权 + 127.0.0.1）/ `processor.py`（纯文档处理，无网络无鉴权）/ `requirements.txt`。
- `packages/provider-sdk`：`driver.ts`（ModelDriver 端口）/ `adapters/openai.ts`（fetch+SSE 流式，`[DONE]` 终止）/ `router.ts`（按任务类型选模型）/ `index.ts`。
- `packages/agent-runtime`：`executor.ts`（DAG 执行器：构造期环检测、ready 队列、ToolRunner 端口注入、事件发射）。
- `apps/workbench`：`App.tsx`（三栏布局）/ `Sider.tsx`（可折叠导航）/ `MessageThinking.tsx`（纯展示）/ `PreviewPanel.tsx`（多 Tab 预览）/ `BrowserViewer.tsx`（单 active tab 安全桥）/ `main.tsx`。

### 附注
- 代码/文档均按《积木架构铁律》：一文件一职责、靠渠道通信、替换实现只换 adapter 不换 port。
- UI 组件参照 AionUi（Layout/Sider/MessageThinking/PreviewPanel/BrowserViewer），已核证真实组件命名。


## [2026-08-19] v0.3.0 可信执行链基础：可验证事件 + 默认拒绝 + 审批门控

### 决策
- **事件信封升级为 v1.0**：所有 `TaskEvent` 强制携带 `protocolVersion`、`eventId`、`taskId`、`runId` 与时间戳，作为 C3/C6 事件关联、回放和审计的最小前提。
- **能力策略默认拒绝**：未声明的 capability/risk 组合一律产生 `CAPABILITY_DENIED`，不得触达底层 `ToolRunner`；需要审批的规则只在明确批准后执行。
- **运行时校验作为通道入口**：`packages/protocol` 用 JSON Schema 提供 `validateTaskEvent()` / `isTaskEvent()`，用于校验来自 UI、进程、sidecar 或事件日志的未知输入。

### 新增
- `packages/protocol/src/task-event-validator.ts`：TaskEvent JSON Schema 运行时校验器与结构化错误输出。
- `packages/protocol/src/index.ts`：协议包唯一公共入口，导出类型与校验端口。
- `packages/agent-runtime/src/capability-policy.ts`：C4 `RuleBasedCapabilityPolicy` 适配器，精确风险规则优先、缺失规则默认拒绝。
- `packages/agent-runtime/src/controlled-tool-runner.ts`：策略→审批→工具端口的受控执行器，发出拒绝、审批、调用与结果事件。
- 协议、DAG 与受控执行链共 9 个自动化测试；根 `npm test` 统一执行。
- 工作台开发依赖升级至 Vite 8 / React 插件 6，消除原有开发服务器的高危依赖告警。

### 修正
- **原 DAG 事件未包含可回放信封字段**。
  → 处置：`DAGExecutor` 新增 `DAGRunContext`，所有工具调用/结果事件均带 v1.0 envelope 和稳定 `eventId`。
- **JSON Schema 组合规则会将基础信封字段误判为额外字段**。
  → 处置：调整组合规则，保留对事件类型、必填字段、风险级别和 capability 枚举的严格校验。

### 验证
- `npm run typecheck` ✅
- `npm test` ✅（9/9）
- `npm run typecheck --workspace=@awo/workbench` ✅
- `npm audit --audit-level=high` ✅（0 vulnerabilities）

### 后续边界
- 本版本提供运行时策略门控基础，不替代 Rust 控制面中的密钥存储、OS 权限、进程隔离或事件持久化；这些能力将在后续经 C1/C2/C3 通道接入。


## [2026-08-19] v0.4.0 运行时纪律：上下文预算 + 执行预算

### 参考与决策
- **OpenCode 公开参考**：其 Plan/Explore 等角色以权限收紧实现只读与计划模式，并在相同工具调用重复时触发 doom-loop 保护；本仓以独立 TypeScript 领域模型实现预算与阻断，不复制其实现。
- **AtomCode / Claude Code 公开参考**：吸收按 turn 管理上下文、工具结果压缩、结构化事件、工具前执行门控的原则；本仓仍坚持策略 → 审批 → 预算 → 工具端口的单向顺序。
- **参考归档边界**：`reference/ClaudeCode_静态补全候选_20260818.zip` 保持非构建资料；本轮只核查其索引与归档清单，未解压、未执行、未引用其中代码。

### 新增
- `packages/agent-runtime/src/context-budgeter.ts`：依据稳定优先级在 token 预算内挑选上下文，并在超额时发出 `context.compacted` 事件，供后续摘要器与事件日志消费。
- `packages/agent-runtime/src/execution-budget.ts`：按 `runId` 隔离的总步骤和重复调用预算；默认阻断相同工具/输入指纹的循环，不跨任务污染状态。
- `execution.blocked`、`context.compacted` 两类协议事件及对应 JSON Schema 契约。
- 7 项新增自动化测试，覆盖压缩选择、非法上下文、总步骤上限、重复调用、跨 run 隔离与受控执行链预算阻断。
- `docs/research/atomcode-public-architecture-notes-2026-08-19.md`：OpenCode、AtomCode 和 Claude Code 官方公开资料的架构提炼与参考边界。

### 验证
- `npm run typecheck` ✅
- `npm test` ✅（16/16）
- `npm run typecheck --workspace=@awo/workbench` ✅

### 后续边界
- 本版本不会自动摘要内容、不会写入任务存储、不会创建子 agent，也不会执行 Hook。预算器只产生可解释决策；后续能力必须通过既有协议和权限链接入。


## [2026-08-19] v0.5.0 AionUi 对齐工作台切片

### 产品与设计

本版本将 `apps/workbench` 从静态演示升级为具备产品层级的三栏工作台。布局以 AionUi 公开的 Layout、Sider、SendBox、PreviewPanel 和 PreviewTabs 的**边界分工**为主参照，但采用独立组件、独立视觉 token 和独立代码实现。左栏负责品牌、工作区和导航；中栏负责任务目标、Agent 状态、事件时间线与输入意图；右栏作为宿主级、持久化的交付预览容器。

### 新增能力

工作台新增深色任务空间主题、运行时状态芯片、能力标签、任务活动时间线、可提交的目标输入区及多标签交付预览。输入目标并点击“生成计划”会在前端创建符合 `TaskEvent` 契约的 `task.created` 和 `plan.proposed` 事件，随即更新当前目标和活动计数。此行为明确标记为 UI 意图演示，尚不绕过或替代真实的 Agent、权限、审批、预算和存储链路。

### 工程与验证

工作台新增标准 `build` 脚本并升至 v0.2.0，根工程版本升至 v0.5.0。本次通过了 Vite 生产构建、工作台严格 TypeScript 检查、根 TypeScript 检查、16 项协议与运行时测试，以及高危级依赖审计（0 vulnerabilities）。浏览器验收确认三栏布局正常渲染，提交目标后会新增两条事件并更新任务标题。

### 参考边界

已新增参考能力矩阵，整合 DeepSeek-Harness、OpenWorker、UI-TARS、MiMo-Code、OpenClaw、ClawCode、LobeHub、Chatbox、Cherry Studio、AnythingLLM、Jan、AionUi、OpenCode、AtomCode 与 Claude Code 官方公开资料的高层能力方向。参考资料不进入运行时构建链；所有实现均通过 b07-build 自有协议、端口和测试落地。


## [2026-08-19] v0.6.0 Agent Profile 与权限收紧

### 运行时能力

新增 `build`、`plan`、`explore` 三种 Agent Profile。Profile 同时定义工具调用上限、相同调用上限、上下文预算和能力规则，并通过 `ProfiledCapabilityPolicy` 与任意基线策略组合。组合语义是单向收紧：Profile 可以把基线授权升级为审批或拒绝，但不能放宽基线拒绝。由此，Plan 明确拒绝文件写入与 Shell，Build 将写入、网络、Shell 和浏览器操作置于审批门控，Explore 保持严格只读并压低步骤与上下文预算。

### 协议与工作台

`TaskEvent` 新增 `agent.profile.selected` 事件及封闭 JSON Schema。工作台标题栏新增 Build、Plan、Explore 切换器；切换会更新模式标签，并将选择追加至任务活动流。Profile 当前通过事件契约与运行时策略共享同一枚举；真实任务工厂将在下一阶段负责将选中 Profile 装配到 ToolRunner、审批端口、预算器与任务会话。

### 验证

新增 4 项 Profile 策略测试和 2 项 Profile 事件契约测试。完整测试套件现为 22/22 通过；工作台严格 TypeScript 检查通过，浏览器验收确认 Plan 切换会同步更新视觉状态和事件流。


## [2026-08-19] v0.7.0 并发 DAG 调度与性能观测

### 调度优化

`DAGExecutor` 从逐 wave 串行执行和重复扫描 pending 集合，升级为索引化、完成驱动的有限并发调度器。它在执行前以 O(V+E) 构建节点索引、反向依赖和入度，并拒绝重复节点、未知依赖、重复依赖、空节点标识和有环图。节点完成时只更新直接后继的剩余依赖，避免在大任务图上反复扫描无关节点。

### 并发与安全

新增显式 `maxConcurrency` 选项，默认上限为 4。独立节点可在受控工作池内并发执行；同一节点仍保持 `tool.called → tool.result` 的事件顺序。调度器只组织已提供的 `ToolRunner` 调用，不绕过 `ControlledToolRunner` 的权限、审批或执行预算。工具异常会转写为 `TOOL_FAILED` 结果事件，防止一个节点的异常让调度统计和后继处理失去可见性。

### 观测与基准

新增 `DAGExecutionStats` 观测端口，以及 `npm run benchmark:dag` 可复现基准。基准在 24 个彼此独立、每个模拟 5ms I/O 的节点上比较受控并发池与串行执行：串行约 130.12ms，四并发约 31.89ms，约 4.08× 加速。该数据仅衡量调度与异步等待重叠，不代表模型、网络或 sidecar 的端到端性能。

### 验证

新增 4 项并发 DAG 用例；完整测试套件为 26/26 通过。工作台生产构建、TypeScript 检查及高危级依赖审计（0 vulnerabilities）均通过。


## [2026-08-19] v0.8.0 本地可恢复任务运行时

### 本地优先运行时

新增 `RecoverableTaskRuntime` 与 `TaskSnapshotStore` 端口，将 Agent Profile、基线能力策略、审批端口、执行预算、受控工具执行器和并发 DAG 调度器组装为单一任务运行边界。内置 `InMemoryTaskSnapshotStore` 用于开发和测试；后续 SQLite append-only 适配器可在不修改领域调度语义的情况下替换该端口。

### 恢复语义

运行时在启动、每个节点终态和最终完成时写入快照。恢复时仅跳过已经成功的节点；failed 和 blocked 节点会重新接受 Profile、策略、审批和预算检查。审批缺失会将任务标记为 `blocked`，审批通过后只运行未完成节点。Plan Profile 对写入的明确拒绝则保留为 `failed`，且绝不触达底层工具。

### 调度终态

DAG 执行器新增已完成节点恢复入口、节点终态观测及 `emitToolEvents` 选项。受控工具执行器现在显式区分审批/预算造成的 `blocked` 与工具失败；失败会沿依赖边级联阻断后继，确保每个节点都进入可见终态，不遗留悬空任务。

### 验证

新增 3 项可恢复任务与失败级联用例，完整测试套件达到 29/29 通过。完整 TypeScript 检查通过。


## [2026-08-19] v0.9.0 本地任务控制、持久恢复与能力感知模型路由

### 决策

- **持久化保持在端口之后**：`SqliteTaskSnapshotStore` 是 `TaskSnapshotStore` 的 append-only adapter；调度、策略和恢复语义继续归属于运行时领域层。这样可替换数据库实现而不改变任务运行行为。
- **产品入口统一到服务边界**：新增 `LocalTaskRuntimeService` 的 `submit`、`resume` 和 `snapshot` 三个入口。工作台、CLI、HTTP 与 IPC 适配器必须复用这条路径，禁止直接操纵 DAG、审批状态或快照。
- **路由将数据边界视为硬约束**：`local-only` 过滤全部远程候选；`local-preferred` 仅在能力满足后提高本机候选分数。路由排序使用分数降序、driver ID 升序，使同一注册集合的选择可复现。
- **Provider adapter 不承载策略**：OpenAI-compatible、本地 OpenAI-compatible 与 Anthropic Messages adapter 只做协议转换、能力声明和 SSE 解析；成本、隐私、上下文与能力选择集中在 `ModelRouter`。

### 新增

- `crates/process-supervisor/src/control_plane.rs`：`TaskRunState`、`SchedulerStats`、`TaskRunSnapshot` 与 `TaskControlPlane`，覆盖注册、运行、心跳、统计、取消和终态边界。
- `packages/agent-runtime/src/sqlite-task-snapshot-store.ts`：使用 Node 内置 `node:sqlite` 的 SQLite WAL append-only 快照实现，提供历史记录与最新快照恢复，并避免泄漏可变内部对象。
- `packages/agent-runtime/src/task-runtime-service.ts`：本地任务运行时服务边界，验证提交任务、恢复已保存任务及读取最新快照。
- `packages/provider-sdk/src/driver.ts`：`ModelCapabilities` 与成本分层契约，显式建模上下文窗口、工具、视觉和本地执行能力。
- `packages/provider-sdk/src/router.ts`：`ModelRouteRequest`、候选评分和可解释 `ModelRouteDecision`，按数据边界、能力、成本及稳定顺序选模。
- `packages/provider-sdk/src/adapters/local-openai.ts`：面向 Ollama、LM Studio、vLLM 等本机 OpenAI-compatible 服务的低成本、本地标签 adapter。
- `packages/provider-sdk/src/adapters/anthropic.ts`：Anthropic Messages 流式 adapter，处理 system/message 正规化和 `content_block_delta` SSE 事件。
- Provider、任务服务和 SQLite 测试；完整 TypeScript 测试套件由 29 项扩展至 **38 项**。

### 修正

- **早期路由器只按任务类别硬编码 provider**，无法表达上下文下限、工具/视觉需求、数据边界或选择理由。
  → 处置：以可过滤的能力契约和稳定评分替换硬编码分支，同时保留 `pick(kind)` 作为向后兼容入口。
- **早期 OpenAI-compatible adapter 固定返回 `openai` 且没有能力元数据**，使本地端点无法作为严格本地任务候选。
  → 处置：允许配置 driver ID 与能力；本地端点改由独立 `LocalOpenAICompatible` 显式声明本地性。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 38/38 通过（Node SQLite 实验性提示预期存在） |
| `cargo fmt --check && cargo check && cargo test` | 4/4 通过，零格式差异 |
| Rust doc-tests | 通过（0 项） |

### 后续边界

- 本版本定义并测试了任务服务与路由 adapter；工作台尚未在浏览器中直接调用该服务。下一步通过 C1/C2/C3 adapter 接入真实快照、审批与恢复状态，不将 Node SQLite 或 Provider 密钥导入前端。
- Anthropic adapter 目前覆盖文本流式响应。原生 tool-use 请求和多模态内容块必须先扩展协议 `ChatRequest`，再通过可验证事件接入，不在 adapter 内部私自改变调用语义。
- Rust `SchedulerStats` 尚未消费 TypeScript 调度器的实时统计；该同步将通过版本化 JSON-RPC 或文件 IPC 增加，避免任一语言直接访问另一方内部内存。


## [2026-08-19] v0.10.0 工作台真实闭环、统计 IPC 与本地知识基础

### 决策

- **浏览器只持有意图与 DTO**：`WorkbenchTaskClient` 只接受目标、Profile、恢复与审批意图，并返回经过客户端形状检查的快照及经协议校验的事件。浏览器永不构造 DAG、工具、基线策略、审批集合或 SQLite 句柄。
- **开发网关只在回环地址服务**：`apps/runtime-gateway` 绑定 `127.0.0.1`，在可信服务端装配固定的本地任务模板、`RuleBasedCapabilityPolicy`、审批端口、空副作用 runner 和 SQLite 快照。该网关是开发会话桥接，不是常驻生产服务。
- **审批演示不产生文件副作用**：Build 模板中的 `workspace.write.intent` 用来验证审批、恢复和事件顺序，runner 只输出 `local://` 引用；它不会写文件、执行 Shell 或调用网络。
- **跨语言统计采用独立版本化消息**：Rust `SchedulerStatsMessage` 使用 `awo.scheduler.v1`、`schemaVersion=1` 和严格 JSON 字段，避免 Rust 与 TypeScript 直接共享内存或数据库实现。
- **知识结果必须有来源**：本地知识流程只摄取已解析文本、使用确定性分块与词法检索，并返回 chunk、文档和 URI 引用。网络摄取、模型摘要和向量索引仍留在可替换 adapter 之后。

### 新增

- `apps/runtime-gateway/src/main.ts`：回环 HTTP 网关，提供提交、快照、事件、恢复和指定节点审批入口；服务端生成受控 DAG 并持久化 SQLite 快照。
- `apps/workbench/src/runtime/task-client.ts`：浏览器任务服务端口与 HTTP adapter，验证快照版本和每个 C6 事件后才更新界面。
- 工作台宿主接入真实运行时状态：显示任务状态、尝试次数、节点数、并发峰值、审批按钮和快照恢复按钮；时间线不再伪造执行记录。
- `crates/process-supervisor/src/scheduler_stats_ipc.rs`：SchedulerStats JSON 编解码、字段/版本/标识校验与 Rust 控制面投影。
- `packages/knowledge-workflow`：本地知识文档、分块、引用、Store 端口、内存 adapter 与确定性检索实现。
- `docs/validation/workbench-runtime-loop-2026-08-19.md`：工作台真实闭环的浏览器验收记录。

### 修正

- **工作台首次连接真实网关时拒绝事件流**：`ControlledToolRunner` 在可恢复阻断时发送了 `blocked`，但 `ToolResultEvent` 类型与封闭 JSON Schema 未允许该字段。
  → 处置：将可选 `blocked: boolean` 纳入 `tool.result` 类型和 Schema。浏览器验收确认 9 条阻断前真实事件与审批后的 12 条完整事件均可通过校验并显示。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 43/43 通过 |
| `npm run build --workspace=@awo/workbench` | 通过 |
| `cargo fmt --check && cargo check && cargo test` | 6/6 通过 |
| 回环 HTTP 闭环 | Build：审批前 `blocked`，批准 `deliver` 后 attempt 1 → 2、仅重跑未完成节点并达到 `completed` |
| 浏览器验收 | 工作台渲染真实 SQLite 快照、9 条审批前事件与 12 条恢复后事件 |

### 后续边界

- 开发网关的请求元数据仅保留在进程内；SQLite 已保存快照，但进程重启后恢复完整请求仍需桌面壳安全保存已授权任务定义，绝不从浏览器重建工具参数。
- Rust IPC 当前是已测试的 JSON 消息契约；真实 JSON-RPC/文件监听 adapter、心跳发送和取消回传将在桌面控制面阶段实现。
- 本地知识流程当前为可验证词法基线；SQLite FTS/向量 Store、受控文档解析任务、检索事件与工作台引用预览将沿既有端口扩展。


## [2026-08-19] v0.11.0 SQLite 本地向量检索与可追溯引用预览

### 决策

- **适配当前 Node SQLite 能力而不降级产品边界**：运行时探测表明 Node 内置 `node:sqlite` 不包含 FTS5 模块。根据既定“SQLite FTS 或向量存储”目标，采用无需 SQLite 扩展的 SQLite 稀疏向量适配器，而非引入原生 addon 或在 UI 内构造索引。
- **向量保持可解释、可替换且本地化**：`SqliteVectorKnowledgeStore` 以普通 SQLite 表保存确定性词项/汉字二元组的归一化稀疏向量，并使用 cosine 相似度排序。它不声称为语义 embedding；后续 dense embedding、sqlite-vec 或 FTS5 adapter 可复用 `SearchableKnowledgeStore`。
- **引用预览只消费服务端 DTO**：工作台右栏新增“引用”标签。浏览器只发送查询并校验 `{documentId, chunkId, sourceUri, title, excerpt, score}`；文档摄取、SQLite 写入和向量计算留在回环网关。

### 新增

- `packages/knowledge-workflow/src/sqlite-vector-knowledge-store.ts`：SQLite WAL、文档/分块/向量三表事务替换、持久化稀疏向量、中文单字与二元组、英文词项及稳定 cosine 排序。
- `SearchableKnowledgeStore` 与 `KnowledgeChunkMatch`：让领域工作流优先调用索引 adapter，并保留内存存储的确定性词法回退。
- 本地网关知识接口：`POST /api/knowledge/documents` 摄取已解析文本；`GET /api/knowledge/search` 返回有来源、有片段、有分数的只读引用 DTO。
- 工作台 `CitationPreview`、`HttpKnowledgeSearchClient` 与“引用”标签：展示本地知识搜索、匹配数、相关度、片段和来源 URI。
- `docs/validation/knowledge-citation-preview-2026-08-19.md`：网关与浏览器端到端引用预览验收记录。

### 修正

- **初始 SQLite FTS5 实现无法运行**：当前 Node 内置 SQLite 返回 `no such module: fts5`，导致 3 项 FTS 测试失败。
  → 处置：删除不可用的 FTS5 实现，改为 SQLite 稀疏向量 adapter；重建持久化、替换、排序、来源和特殊字符查询测试。此路径无需新增原生依赖。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 48/48 通过 |
| `npm run build --workspace=@awo/workbench` | 通过 |
| 回环知识接口 | 摄取 1 个本地文档分块后，查询 `SQLite 引用预览` 返回来源、片段与相似度分数 |
| 浏览器验收 | 右侧“引用”标签显示标题、得分 0.33、文本片段与 `file:///docs/knowledge-runtime.md` 来源链接 |

### 后续边界

- 向量当前是可解释的稀疏词元向量，不等同于语义 embedding，也没有跨文档重排序模型。
- 开发网关本身不执行受控 `document.parse`；生产摄取必须让文档解析由现有 Profile、能力策略、审批、预算和事件链启动，再调用知识存储端口。
- 本地 `file://` 引用由宿主环境决定是否可打开；工作台只展示 URI，不绕过桌面壳的文件访问策略。


## [2026-08-19] v0.12.0 AionUi 视觉语言本地化工作台

### 设计决策

- **参考视觉语言而非复制页面**：基于用户提供的浅色聊天页和石墨深色设置页，提炼暖灰画布、石墨层级、细分隔线、柔和圆角、紧凑侧栏和低饱和强调色。未复制品牌图标、账户页、模型页或截图中的非本项目业务结构。
- **默认浅色，显式深色**：工作台以浅色石墨主题作为默认值，并提供本地主题切换。深色模式延续近黑背景和低对比面板，但不沿用旧版高饱和深蓝底色。
- **视觉只作用于产品壳**：任务 submit/resume/approve、SQLite 快照、协议事件和知识引用仍沿原有浏览器 DTO → 回环网关 → 运行时边界运行；样式重构不在 UI 中增加数据库、Provider 或工具访问。

### 新增与调整

- 新增 `theme-light` / `theme-dark` 设计令牌：画布、侧栏、面板、边界、文字、语义状态、焦点环和阴影均由令牌驱动。
- 本地化三栏工作台：侧栏改为轻量品牌、工作区导航、当前工作区状态与主题开关；中心区强化目标输入与运行时快照；右栏维持交付和知识引用预览。
- 更新任务语言与层级：欢迎区使用成果导向标题，输入动作使用“开始任务”，但不改变实际任务 API 或审批语义。
- 新增 `docs/design/aionui-localization-notes-2026-08-19.md`，记录截图可验证视觉规律、映射决策与浏览器验收。

### 验证

| 检查 | 结果 |
|---|---|
| 浅色主题浏览器验收 | 暖灰画布、浅灰侧栏、白色卡片、柔和边界与中心输入焦点可见 |
| 石墨深色浏览器验收 | 近黑画布、石墨层级、可读文本与低饱和语义状态可见 |
| 真实任务回归 | Build 任务提交后显示并发峰值 1、等待审批快照、3 个节点、9 条真实事件以及恢复入口 |
| `npm run typecheck` | 通过 |
| `npm run test` | 48/48 通过 |
| `npm run build --workspace=@awo/workbench` | 通过 |

### 后续边界

- 当前主题状态只保存在 React 会话内；持久化到桌面设置应通过受控设置服务完成，而不是浏览器直接写入本地文件。
- 工作区导航中的非任务会话项是已可见的信息架构入口；具体页面应在对应真实服务边界完成后逐项接入。


## [2026-08-19] v0.13.0 本地会话控制与个人学习产品融合

### 公开架构研究与产品决策

- 以 **OpenClaw** 的本地 Gateway、会话所有权、SQLite session metadata、显式 durable/incognito 模式和隔离 Agent 边界作为本轮最高优先级参考。
- 参考 **OpenCode** 的主角色/子角色、最小权限和受限 Plan 模式，将 Profile 与未来 persona/工作区隔离明确分开。
- 参考 **DeepSeek Harness** 的可替换 capability seam、append-only 可追溯运行和 preset 组合，但坚持使用封闭 manifest 与受控 adapter 注册表，而不引入可执行的通用动态插件。
- 参考 **AnythingLLM、Open WebUI、Jan、5ire** 的工作区知识、本地模型、多 Provider 和 MCP 产品边界，形成 Local Model Endpoint、Knowledge Workspace、MCP Registry 的后续优先级。
- 新增 `docs/research/personal-learning-product-fusion-plan-2026-08-19.md` 及四份公开架构研究记录，包含可融合能力、非目标范围、路线版本和验收标准。

### Session Control Plane v1

- 新增 `LocalSessionControlPlane` 与稳定领域 DTO：`LocalSessionScope`、`LocalSessionSnapshot`、`SessionSnapshotStore`、`SessionPersistenceMode`。
- 引入 `durable`、`ephemeral`、`incognito` 三种会话模式：只有 durable 会话进入持久 store；ephemeral/incognito 只保留在当前进程；领域快照不包含原始 transcript、模型 token 或工具 payload。
- 新增 append-only `SqliteSessionSnapshotStore`，启用 WAL 并提供最新快照、历史回放和按更新时刻的稳定列表读取。
- 新增 `stateVersion` 乐观并发检查、touch、pin、archive 与 reset；重置会归档旧会话并新建同 scope 的独立会话。
- 新增 5 项会话控制测试，覆盖 durable 恢复、incognito 隔离、陈旧客户端冲突、重置语义和 SQLite immutable history。

### 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 53/53 通过 |
| v0.13 后续重点 | Session/Task Control Gateway v1、幂等收据、snapshot gap refresh、只读子任务与 Runtime Preset Manifest |


## [2026-08-19] v0.14.0 分层记忆账本与上下文治理

### 记忆与检索研究

本版本研究并记录了 OpenClaw 的分层记忆、压缩前保存、隔离 recall，以及 Open WebUI 的记忆类型、范围、独立注入预算和可审查删除模式。[1] [2] 新增 `docs/research/memory-compaction-retrieval-notes-2026-08-19.md` 与 `docs/research/next-development-priorities-2026-08-19.md`，将可靠控制协议、Memory Ledger、上下文压缩、本地模型、知识工作区、只读子任务和 MCP 注册表按依赖关系排序。

### Memory Ledger v1

| 能力 | 已实现边界 |
|---|---|
| 领域契约 | `MemoryRecord`、`MemoryScope`、`MemoryProvenance`、`MemoryKind` 与 `MemoryStatus`；每条记录有来源、信任、范围、过期和 token 估计。 |
| 审查状态 | 新记录默认为 `candidate`；只有显式 `confirm()` 的记录才可进入上下文。`retract()` 与 `supersede()` 通过 revision 追加修订。 |
| 隐私与隔离 | `incognito` session 禁止写入或修订持久记忆；agent、workspace、可选 session scope 与过期条件均在选择前过滤。 |
| 上下文治理 | preference 与其他记忆使用独立 token 预算；每个选择结果包含分数、原因和 provenance，同时硬编码 `canAuthorize: false`。 |
| 本地持久化 | `SqliteMemoryLedgerStore` 使用 WAL + append-only revision；保留 `history()` 以支持用户审查、诊断与未来回放。 |

### 验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test` | 57/57 通过 |

[1]: https://docs.openclaw.ai/concepts/memory "OpenClaw Memory overview"
[2]: https://docs.openwebui.com/features/chat-conversations/memory/ "Open WebUI Memory & Personalization"
