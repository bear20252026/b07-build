# v0.19.0 后续：零件化 Gateway 与架构适应度重构

**作者：Manus AI**

**日期：2026-08-19**
**范围：AI Work OS v0.19.0 发布后的结构性重构**

## 目标与结论

本轮将 AI Work OS 从“边界正确但 Gateway 集中”的状态，推进为更严格的 **模块化单体 + Ports and Adapters + 明确 Composition Root + 自动化架构适应度函数**。重构没有引入任何自动执行能力，也没有改变 Extension、Provider、Skill Pack、Agent Adapter、Schedule 的安全语义。

> **不变原则：** manifest、Profile、Skill Pack、Adapter handshake/mailbox、Schedule run 与 approval 都只是可审计 metadata；它们不能自行加载、连接、spawn、读取密钥、调用工具或绕过实时 policy、预算和审批。

| 目标 | 重构前 | 重构后 |
| --- | --- | --- |
| 进程入口 | `main.ts` 同时承担 Gateway 全部职责，约 1,143 行。 | `main.ts` 为 14 行，仅管理启动与 SIGINT/SIGTERM 生命周期。 |
| Composition Root | 模块导入时即读取环境并创建 SQLite adapter。 | `createGatewayComposition()` 显式创建依赖图；import 本身不打开数据库。 |
| HTTP 路由 | 单一 `handle()` 集中所有能力族与 DTO 校验。 | 40 行 Router 管道顺序组合 6 个能力 route；每个 route 只依赖 `GatewayDependencies`。 |
| HTTP 通用行为 | JSON body、响应、错误处理混在 Gateway 大文件。 | `http/boundary.ts` 单独提供受限 JSON、HTTP context、响应与错误映射。 |
| 领域基础设施 | 三个通用 SQLite store 位于 Agent Runtime 根目录。 | 迁入 `agent-runtime/src/infrastructure/sqlite/`，并保持公共 export 稳定。 |
| 复杂领域聚合 | Agent Adapter、Schedule、Skill Pack 与根目录并列。 | 实现迁入各自 `modules/<capability>/control-plane.ts`；根文件是兼容 facade。 |
| 架构执行 | 主要依赖人工审查。 | `dependency-cruiser` + 项目内 `architecture-check.mjs` 在 `npm test` 前自动执行。 |

## 新的 Gateway 组装管道

```text
main.ts
  └─ startLocalGateway()
       └─ createGatewayComposition()
            ├─ 读取本地环境配置
            ├─ 创建 SQLite / in-memory adapter
            ├─ 装配领域 Control Plane 与 Policy
            └─ 注入 GatewayDependencies
                 └─ handleGatewayRequest()
                      ├─ schedules route
                      ├─ agent-adapters route
                      ├─ skills-providers route
                      ├─ extensions + MCP route
                      ├─ knowledge route
                      └─ tasks route
```

| 文件或目录 | 唯一责任 | 明确禁止事项 |
| --- | --- | --- |
| `apps/runtime-gateway/src/main.ts` | 进程启动与关闭信号。 | 不读取 SQLite、不定义路由、不包含领域状态机。 |
| `gateway-application.ts` | 具体 adapter 与领域控制面的 composition root。 | 不解析 HTTP DTO，不逐端点处理业务意图。 |
| `http/router.ts` | 路由族顺序与统一错误出口。 | 不创建 Store、Provider、进程或 Policy。 |
| `http/routes/*.ts` | 一个能力族的 HTTP DTO 校验与控制面调用。 | 不直接创建 `Sqlite*` adapter、监听端口或读取环境变量。 |
| `http/boundary.ts` | Node HTTP 输入/输出适配与 body 限额。 | 不包含业务状态机。 |
| `agent-runtime/src/infrastructure/sqlite` | 实现领域定义的 Store port。 | 不向 UI 暴露 SQLite，不决定产品权限。 |
| `modules/<capability>/control-plane.ts` | 单一业务方向的类型、账本与状态机。 | 不反向依赖 Gateway/Workbench。 |

## 自动化架构适应度函数

`npm run architecture:check` 现在执行两层校验。

| 校验层 | 实现 | 拒绝的结构侵蚀 |
| --- | --- | --- |
| 依赖图 | `.dependency-cruiser.cjs` | 循环依赖、Workbench 直接导入 Agent Runtime/Provider/Knowledge、领域反向导入 apps、route 直接导入基础设施 adapter。 |
| 文本/尺寸边界 | `tools/architecture-check.mjs` | UI 的 Node/SQLite/进程导入、领域反向 app 依赖、route 中 SQLite/server/env、Gateway 入口/组合根/router 的行数预算、旧 SQLite 根路径回流。 |

该方法把“架构应该保持零件化”从口头约定转为失败即阻断的工程契约。依赖图工具可验证静态 import 与循环依赖；项目内检查补足由运行时 API、Node 内置模块和文件尺寸带来的边界风险。[1] [2]

## 兼容性与验证

本轮为结构性改造，不改变公开包入口。`agent-adapter.ts`、`audited-scheduler.ts`、`skill-pack.ts` 以及既有 SQLite store 的公共导出仍保持可用，测试和 Gateway 装配不需要改用新的内部路径。

| 验证项目 | 结果 |
| --- | --- |
| dependency-cruiser | 118 modules、288 dependencies；无循环或越层依赖违规。 |
| 自有架构检查 | 通过；Workbench/领域/route/基础设施边界与 Gateway 尺寸预算均满足。 |
| TypeScript 严格检查 | 通过。 |
| 全量 TypeScript 回归 | 106/106 通过。 |
| Workbench 生产构建 | 通过。 |
| Rust format/check/test | 9/9 通过。 |
| 隔离 Gateway HTTP 回归 | 通过：metadata 路由保持只读、incognito 知识访问被拒绝、Build Task 仍进入 approval-gated `blocked` 状态。 |

## 后续演进规则

后续新增能力应先判断其属于哪个业务模块，再决定 port 与 adapter：若涉及外部 I/O、可替换实现、权限边界或持久化，则在领域模块定义最小 port，并在 `infrastructure/` 实现 adapter；若只是本地业务规则，则放在相应 `modules/<capability>` 内。不要为了形式给每个函数制造 interface，也不要让 Gateway route 成为新的业务状态机。

在准备将 Agent Adapter transport 或 Schedule run 接入真实受监督执行器时，应创建新的独立 route/control-plane/host 模块，并在 `architecture:check` 中新增禁止其绕过 `ControlledToolRunner`、实时 policy、预算与审批收据的规则。

## References

[1] [Kamil Grzybek, Modular Monolith: Domain-Centric Design](https://www.kamilgrzybek.com/blog/posts/modular-monolith-domain-centric-design)

[2] [dependency-cruiser Documentation](https://github.com/sverweij/dependency-cruiser)
[3] [Domain-Driven Hexagon](https://github.com/Sairyss/domain-driven-hexagon)
