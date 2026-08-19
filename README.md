# AI Work OS

> **v0.19.0** — 本地优先、可恢复、受控执行且具备受控扩展平面、可审查上下文与审计调度的个人 Agent 学习工作系统。

AI Work OS 采用积木式三语言架构：**Rust** 负责进程监督与任务控制面，**TypeScript** 负责产品编排、策略、可恢复运行时与模型路由，**Python** 负责可替换的重计算 sidecar。工作台只提交意图和订阅事件；它不直接访问快照存储、Provider 密钥或工具实现。

## 当前能力

| 领域 | 已实现边界 | 当前保障 |
|---|---|---|
| 事件协议 | `TaskEvent` v1.0、封闭 JSON Schema、运行时验证、可回放信封 | 拒绝未声明字段与不完整 run 元数据 |
| 受控执行 | 默认拒绝能力策略、Profile 单向收紧、审批门控、上下文与执行预算 | 任何底层工具调用先经过策略、审批和预算 |
| 并发调度 | 索引化完成驱动 DAG、有限并发、失败级联阻断、统计端口 | 成功节点可恢复跳过，后继节点不悬空 |
| 本地恢复 | `TaskSnapshotStore` 端口、内存实现、SQLite append-only 历史与恢复 | 快照只追加；读取返回防御性副本 |
| 会话控制 | `LocalSessionControlPlane`、durable/ephemeral/incognito、乐观 `stateVersion`、归档、pin 与 reset | incognito/ephemeral 不进入持久 session store；会话不保存原始 transcript 或工具 payload |
| 分层记忆 | `MemoryLedger`、candidate/confirmed/retracted 修订、scope/path、来源、信任、过期和独立注入预算 | 记忆不等于权限；仅 confirmed、范围匹配且未过期条目可带引用进入上下文；incognito 禁止持久化 |
| 受控扩展 | `ExtensionManifestV1`、来源 digest、激活计划、诊断、Rust 监督宿主与只读工作台 Extension Center | manifest 仅为 metadata；登记不加载、不启动、不授予工具权限 |
| Provider Profile | 追加式配置、driver allowlist、数据边界收紧、credential reference、回滚与撤销 | 只保存引用名，不保存 secret；Profile 只能收紧不能放宽候选集 |
| Skill Pack | 纯文本 pack、候选审查/发布、来源 digest、显式 token 预算、范围与撤销验证 | 不隐式注入，不索引为普通文档，固定 `canAuthorize: false` |
| 外部 Agent Adapter | ACP/CLI manifest、握手能力协商、独立 session、只读桥与审批 mailbox | 不启动外部 Agent；未声明能力被审计性拒绝；任何 bridge intent 不可执行 |
| 审计调度 | 时区化 interval manifest、独立 runId、模板 digest、预算、missed slot 与审批 inbox | 只规划不可执行 run；高风险默认待审批，无后台 timer 或自动 runner |
| 服务边界 | `LocalTaskRuntimeService` 的 submit / resume / snapshot 入口 | UI、CLI 与后续 HTTP/IPC adapter 可复用同一任务语义 |
| Rust 控制面 | 进程监督、任务生命周期、心跳、取消边界与调度统计模型 | 控制面不触碰 TypeScript 业务策略 |
| Provider | OpenAI-compatible、Local OpenAI-compatible、Anthropic Messages 流式 adapter | 按上下文、工具、视觉、成本和数据边界确定性选模 |
| 跨语言控制 | Rust `SchedulerStatsMessage` v1 的严格 JSON 编解码与控制面投影 | 拒绝未知字段、错误版本、标识冲突和非法统计 |
| 本地知识 | SQLite 持久化稀疏向量、确定性分块、相似度检索、来源引用与可替换 Store 端口 | 不调用网络或模型；Node SQLite 无 FTS5 时仍能本地运行；结果必有来源 URI 和 chunk 引用 |
| 工作台 | AionUi 参考下的浅色石墨三栏界面、可切换深色主题、Profile 切换、真实任务事件、SQLite 快照、审批恢复与引用预览 | UI 仅提交目标/Profile/查询意图并消费验证后的 DTO；不接触工具、密钥或数据库 |

## 架构与通道

```text
apps/workbench ── C1/C2 意图与事件 ──> LocalTaskRuntimeService
                                             │
                      ┌──────────────────────┼──────────────────────┐
                      │                      │                      │
                RecoverableTaskRuntime   TaskSnapshotStore      ModelRouter
                      │                      │                      │
               ControlledToolRunner     SQLite append-only     Provider adapters
                      │                                             │
                      └────── C3/C4 受控端口 ───────────────────────┘

Rust process-supervisor ── C3 JSON-RPC / C5 进程管理 ──> sidecars/document-worker
```

| 通道 | 用途 | 禁止事项 |
|---|---|---|
| C1 | 桌面调用 / 工作台意图 | UI 不直连数据库或模型 Provider |
| C2 | HTTP / WebSocket 服务适配 | 不绕过事件契约和身份边界 |
| C3 | JSON-RPC 控制与跨语言协议 | 不传递未校验的自由形状数据 |
| C4 | Tool / Store / Policy 端口 | adapter 不承载产品策略 |
| C5 | 进程内领域组合 | 不向 UI 泄漏可变内部状态 |
| C6 | 事件订阅与回放 | 事件不能省略 taskId、runId 或版本 |

## 模型路由原则

`ModelRouter.decide()` 接受任务类别、最小上下文、工具/视觉需求及数据边界。`local-only` 是硬约束；`local-preferred` 在满足能力条件后优先本机模型；其余候选依据成本、上下文余量、任务能力和稳定的 driver ID 进行确定性排序。每次选择会产生包含候选分数和理由的 `ModelRouteDecision`，便于写入后续审计事件。

| Adapter | 适用端点 | 路由标签 |
|---|---|---|
| `OpenAICompatible` | OpenAI-compatible 远程服务 | 可配置 ID 与能力；默认远程高成本 |
| `LocalOpenAICompatible` | Ollama、LM Studio、vLLM 等本机 Chat Completions 服务 | `isLocal=true`、低成本、显式上下文与能力 |
| `AnthropicMessages` | Anthropic Messages 流式接口 | system/message 规范化、`content_block_delta` 解析 |

## 验证命令

```bash
# TypeScript：所有工作区与测试的严格检查
npm run typecheck

# TypeScript：协议、权限、预算、DAG、恢复、SQLite、任务服务和 Provider 测试
npm run test

# 调度基准：24 个独立节点，比较串行与有限并发
npm run benchmark:dag

# 工作台生产构建
npm run build --workspace=@awo/workbench

# Rust 控制面
export PATH="$HOME/.cargo/bin:$PATH"
cd crates/process-supervisor
cargo fmt --check && cargo check && cargo test
```

## 目录边界

```text
packages/protocol          事件类型、Schema 与验证（唯一事实源）
packages/agent-runtime     Profile、策略、预算、DAG、任务/会话恢复、快照、Memory Ledger、受控扩展、外部 Adapter、审计调度与任务服务
packages/provider-sdk      模型驱动端口、adapter 与确定性路由
crates/process-supervisor  Rust 进程监督与任务控制面
sidecars/document-worker   Python 文档计算 sidecar
apps/workbench             React 三栏工作台（本地化石墨主题、意图、事件订阅、快照、审批恢复与引用预览）
apps/runtime-gateway       仅限本地开发会话的 HTTP 桥接；服务端装配策略、审批、DAG、SQLite、知识、扩展、Adapter 与调度 metadata
packages/knowledge-workflow 本地文档摄取、SQLite 稀疏向量检索、来源引用与可替换存储端口
docs/research              公开资料架构研究与能力映射
reference                  非构建参考资料，绝不在运行时加载或执行
```

## 下一阶段

v0.19 已完成受控扩展平面：扩展清单与激活诊断、Rust 监督宿主、Provider Profile、只读扩展中心、Skill Pack 治理、外部 Agent 适配和审计调度/审批收件箱均已通过本地 append-only 账本与回归测试落地。下一阶段应将这些**控制面 metadata**与实际受控执行器逐项接合：先实现由 Rust Host 监督的 Adapter transport，再让已批准的 scheduled run 经既有实时 policy、预算、审批收据与 `ControlledToolRunner` claim；不得把 manifest、批准或调度记录直接升级为自动执行权。UI、领域运行时和 Rust 控制面继续保持隔离。
