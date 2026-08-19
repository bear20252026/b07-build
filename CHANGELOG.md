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
