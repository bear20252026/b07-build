# 2026 可演进零件式架构调研：AI Work OS 重构依据

**作者：Manus AI**

**日期：2026-08-19**
**适用范围：AI Work OS v0.19.0 之后的零件化重构**

## 调研结论

AI Work OS 当前适合继续采用 **模块化单体 + Ports and Adapters（六边形）+ 明确 Composition Root + 自动化架构适应度函数**，而不应为拆分而拆成分布式微服务。模块化单体的关键不在部署数量，而在于每个模块有封装的公共接口、私有内部状态、明确依赖方向和可持续执行的边界规则。[1] [2]

> **本轮重构原则：** 网关只做 HTTP/DTO/路由/组合；领域服务只定义用例、状态机和 port；SQLite、进程与网络放在 adapter；模块之间仅经过公开 facade、命令/查询或版本化事件契约；所有规则以自动化检查持续执行。

| 调研主题 | 可验证实践 | 对 AI Work OS 的落地决策 |
| --- | --- | --- |
| 模块化单体 | 模块应自包含、通过明确定义的接口通信，API 层保持薄，只处理 HTTP 和路由。[1] | 将 Runtime Gateway 拆为 bootstrap、HTTP server、router、按能力分类的 routes、DTO guards；其 `main.ts` 仅启动/关闭。 |
| Composition Root | 模块应能自建依赖图；组合根是唯一了解具体 adapter 的位置。[1] [2] | 用 `bootstrap.ts` 集中读取环境变量并把 SQLite adapter 注入领域 service，路由不能直接实例化 SQLite/Policy。 |
| 端口与适配器 | 内层定义 port，外层实现 adapter；核心不依赖框架、数据库、UI 或外部资源。[1] [2] | 维持 Store/Policy/Runner 端口，逐步把 `node:sqlite` 实现移入 `infrastructure/` 子层，保留公共 export 兼容性。 |
| 垂直切片 | 模块按业务能力及共同变化原因组织，而非按所有技术层横切；每个 use case 可单独细分。[1] [2] | Gateway route 按 tasks、knowledge、extensions、providers、skills、agent-adapters、schedules 分组；复杂聚合按 types/store/sqlite/control-plane 拆分。 |
| 命令查询分离 | 写操作表达明确 intent；读取操作不产生状态变化；跨边界契约必须稳定且精简。[2] | 保持 `GET` metadata 与明确 `POST` intent 分离；Schedule plan、approval、Adapter bridge 不直接变成执行权。 |
| 架构适应度函数 | 依赖规则应在 CI 中自动检测，避免边界随迭代侵蚀；dependency-cruiser 可校验 TS/JS 规则和循环依赖。[3] | 加入 repository 内置 `architecture:check`：禁止 UI 进入 Node/SQLite/领域实现，禁止领域反向依赖 apps，禁止跨模块内部导入，并在根 `test`/CI 前运行。 |

## 适用边界

这一方案不主张为了形式而在每个文件建立 interface。只有当变化来源不同、需要可替换实现、需要隔离 I/O 或需要跨模块契约时，才建立 port。否则保持局部直接组合，避免“虚假抽象”。[2]

本轮只做结构性重构：**不改变 v0.19.0 的安全铁律**。Extension manifest、Provider Profile、Skill Pack、Agent Adapter、Schedule 和批准记录仍为 metadata；任何登记、审查、启用、批准或排程不自动加载、连接、启动或执行。

## 参考资料

[1] [Kamil Grzybek, Modular Monolith: Domain-Centric Design](https://www.kamilgrzybek.com/blog/posts/modular-monolith-domain-centric-design)

[2] [Sairyss, Domain-Driven Hexagon](https://github.com/Sairyss/domain-driven-hexagon)

[3] [dependency-cruiser Documentation](https://github.com/sverweij/dependency-cruiser)
[4] [SoftwareSeni, Building Modular Monoliths with Logical Boundaries, Hexagonal Architecture and Internal Messaging](https://www.softwareseni.com/building-modular-monoliths-with-logical-boundaries-hexagonal-architecture-and-internal-messaging/)
