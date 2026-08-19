# v0.18.0：外部 Agent Adapter 与能力协商控制面

**日期：2026-08-19**  
**范围：受控扩展平面 v0.18.0**

本版本在 `@awo/agent-runtime` 实现外部 Agent Adapter 控制面，用于将 ACP 或受限 CLI 型 Agent 的**握手 metadata、协议能力、独立会话、只读意图与待审批高风险意图**纳入本地 SQLite 审计边界。它不负责启动外部二进制、建立外部连接、发送 JSON-RPC、转交环境变量、读取密钥、调用工具或执行文件/终端/浏览器动作。

ACP 的通信模型采用 JSON-RPC 方法与通知；典型流程包括 `initialize`、可选认证、`session/new` 或恢复、`session/prompt`、更新通知与取消。[1] 协议初始化本身用于版本协商和双方 capability 交换，外部 Agent session 应拥有独立会话标识。[2] OpenCode 的 ACP 集成也使用 stdio 上的 JSON-RPC 子进程模式；本项目仅借鉴这种协议分层，不让 manifest 自行启动该子进程。[3]

> **Adapter 登记、审查或 session 协商不是执行授权。** 所有只读桥产物和审批邮箱项目均固定为 `canAuthorize: false`、`canExecute: false`。即使人工在 mailbox 中批准，后续真正执行仍必须回到 `ControlledToolRunner`、实时 capability policy、预算与宿主进程监督边界。

| 控制点 | 实现 | 安全结论 |
| --- | --- | --- |
| 受审 manifest | `AgentAdapterManifestV1` 包含来源 SHA-256、协议/传输、允许能力、数据边界与 `connectionRef`。 | `connectionRef` 只能是无路径的已登记引用，不能携带命令、URL、环境或认证材料。 |
| 审查状态机 | `candidate → reviewed → disabled/revoked`。 | 只有 `reviewed` Adapter 才能协商 session；`revoked` 是终态。 |
| 握手协商 | `negotiate()` 比较 transport、协议版本和 observed capability 与已审查 manifest。 | 未声明能力会列入 `rejectedCapabilities`，不会被静默接受。 |
| 会话隔离 | `adapterSessionId`、`agentSessionId`、父 `taskId/runId` 同时被记录。 | 宿主控制平面 session 与外部 Agent session 不可混同，支持按父运行追溯。 |
| 只读桥 | 只接受 `document.parse`、`model.chat`、`filesystem.read`。 | 返回的是不可执行、不可授权的结构化 intent，而非工具句柄。 |
| 高风险桥 | `approval-required` session 只能创建结构化 mailbox item。 | `filesystem.write`、`shell.execute` 等只形成待审意图；不会被 Adapter 直接运行。 |
| 失效阻断 | session 持有 manifest revision，并在桥接/邮箱决策时复验当前 manifest。 | 停用、撤销或修订漂移会阻断既有 session 与待决审批。 |
| 可恢复审计 | Manifest、session 与 mailbox 各有 append-only SQLite revision store。 | 防御性复制与重开测试避免调用方修改内存返回对象或丢失历史。 |

## 受控 HTTP 路由

本地网关将控制面暴露为本地 HTTP DTO，不向浏览器提供进程启动、连接或执行接口。

| 方法与路径 | 功能 | 执行边界 |
| --- | --- | --- |
| `GET/POST /api/agent-adapters` | 读取或登记 Adapter manifest。 | 仅 metadata。 |
| `POST /api/agent-adapters/:id/review` | 核验 source digest 并写入审核修订。 | 不启动 Agent。 |
| `POST /api/agent-adapters/:id/disable`、`/revoke` | 改变 Adapter 状态。 | 阻断未来桥接。 |
| `POST /api/agent-adapters/sessions` | 写入外部握手得到的 metadata 与能力协商结果。 | 不发送任何 ACP 请求。 |
| `POST /api/agent-adapters/sessions/:id/bridge` | 显式打开只读或待审批意图桥。 | 不运行工具。 |
| `POST /api/agent-adapters/sessions/:id/read-only-intents` | 创建只读 intent DTO。 | 固定不可执行。 |
| `GET/POST /api/agent-adapters/mailbox` | 查看或创建待审批高风险意图。 | 固定不可执行。 |
| `POST /api/agent-adapters/mailbox/:id/approve|deny|expire` | 记录人工或系统决议。 | 决议本身不授权外部 Agent。 |

## 验证记录

| 验证 | 结果 |
| --- | --- |
| TypeScript 严格类型检查 | 通过。 |
| Adapter 专项测试 | 5/5 通过，覆盖 digest、状态机、独立 session、能力拒绝、只读/审批桥、失效阻断和 SQLite 重开。 |
| 网关 HTTP 生命周期 | 通过。真实本地 HTTP 验证显示未声明 `terminal` 被记录为 `rejectedCapabilities`，只读桥仅返回 `canExecute: false` 的 intent；验证过程没有启动或连接外部 Agent。 |

## References

[1] [Agent Client Protocol — Overview](https://agentclientprotocol.com/protocol/v1/overview)  
[2] [Agent Client Protocol — Schema / initialize](https://agentclientprotocol.com/protocol/v1/schema)  
[3] [OpenCode — ACP Support](https://opencode.ai/docs/acp/)
