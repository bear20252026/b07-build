# AI Work OS

> **v0.9.0** — 本地优先、可恢复、受控执行的个人 Agent 工作系统。

AI Work OS 采用积木式三语言架构：**Rust** 负责进程监督与任务控制面，**TypeScript** 负责产品编排、策略、可恢复运行时与模型路由，**Python** 负责可替换的重计算 sidecar。工作台只提交意图和订阅事件；它不直接访问快照存储、Provider 密钥或工具实现。

## 当前能力

| 领域 | 已实现边界 | 当前保障 |
|---|---|---|
| 事件协议 | `TaskEvent` v1.0、封闭 JSON Schema、运行时验证、可回放信封 | 拒绝未声明字段与不完整 run 元数据 |
| 受控执行 | 默认拒绝能力策略、Profile 单向收紧、审批门控、上下文与执行预算 | 任何底层工具调用先经过策略、审批和预算 |
| 并发调度 | 索引化完成驱动 DAG、有限并发、失败级联阻断、统计端口 | 成功节点可恢复跳过，后继节点不悬空 |
| 本地恢复 | `TaskSnapshotStore` 端口、内存实现、SQLite append-only 历史与恢复 | 快照只追加；读取返回防御性副本 |
| 服务边界 | `LocalTaskRuntimeService` 的 submit / resume / snapshot 入口 | UI、CLI 与后续 HTTP/IPC adapter 可复用同一任务语义 |
| Rust 控制面 | 进程监督、任务生命周期、心跳、取消边界与调度统计模型 | 控制面不触碰 TypeScript 业务策略 |
| Provider | OpenAI-compatible、Local OpenAI-compatible、Anthropic Messages 流式 adapter | 按上下文、工具、视觉、成本和数据边界确定性选模 |
| 工作台 | AionUi 风格的三栏深色界面、Profile 切换、事件时间线与常驻预览 | 当前为受控产品外壳；真实服务 adapter 是下一接入点 |

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
packages/agent-runtime     Profile、策略、预算、DAG、恢复、快照与任务服务
packages/provider-sdk      模型驱动端口、adapter 与确定性路由
crates/process-supervisor  Rust 进程监督与任务控制面
sidecars/document-worker   Python 文档计算 sidecar
apps/workbench             React 三栏工作台（意图与事件订阅）
docs/research              公开资料架构研究与能力映射
reference                  非构建参考资料，绝不在运行时加载或执行
```

## 下一阶段

下一阶段将保持既有端口而不把产品逻辑塞入 UI：首先在 Rust 控制面与 TypeScript 调度统计之间建立版本化 JSON-RPC/IPC adapter；其次让工作台通过同一服务边界呈现真实快照、审批请求和恢复操作；最后补充知识摄取、检索与引用工作流，使其继续受到 Profile、预算和快照恢复语义约束。
