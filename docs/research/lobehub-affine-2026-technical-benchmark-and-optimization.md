# AI Work OS：AFFiNE 与 LobeHub 最新技术对标及架构优化建议

**评估日期：** 2026-08-21
**评估对象：** `bear20252026/b07-build` 主分支 `9b8c177`；Windows x64 桌面优先、本机受控 Gateway、第三方模型 API 优先。
**作者：** Manus AI

## 结论

当前 AI Work OS 的正确方向不是把自己扩张成完整的通用协作文档平台或云端多 Agent 托管服务，而是把已经存在的 **Project → Task/Run → Evidence/Files → Delivery → Closeout** 受控执行链做成低延迟、可恢复、可衡量的个人工作操作系统。AFFiNE 近期版本最有价值的启发是稳定对象、可替换视图、本地索引与大对象生命周期；LobeHub 最有价值的启发是把 Agent、任务、技能、项目、审查和可观测性拆为显式领域模块，而非不断扩张聊天页面。[1] [2] [3] [5] [6] [7]

> **推荐策略：不复制上游产品的规模与云端假设；复制其“类型稳定、对象可追溯、能力独立演进、性能持续量化”的工程纪律。**

目前最紧迫的三项瓶颈依次是：Gateway composition root 已达到 350 行硬上限；知识搜索对每次查询全量读取并 JSON 反序列化所有稀疏向量；性能预算只覆盖 bundle 与单文件规模，尚未覆盖用户真正感受到的冷启动、内存、事件积压和 SQLite 延迟。[8] [9] [10]

## 一、最新对标事实

| 维度 | AFFiNE 最新公开信息 | LobeHub 最新公开信息 | 对 AI Work OS 的结论 |
| --- | --- | --- | --- |
| 产品边界 | AFFiNE 将 Docs、Canvas、Tables 组织为同一工作区的 building blocks；其 CE 为 MIT。[1] | LobeHub 将 Agent 作为工作单元，并显式包含项目、任务、技能、记忆和工作区概念；主仓库采用 LobeHub Community License。[5] | 借鉴对象关系和信息架构；不把 AI Work OS 变成通用文档/白板或云端 Agent 平台，也不直接复制 LobeHub 主仓实现。 |
| 可复用底座 | BlockSuite 以独立维护的无头 framework 加可插拔编辑组件分层；其 store 基于 Yjs/CRDT，强调时间回溯和多视图复用。[2] | LobeHub 将 agent runtime、tracing、context engine、model runtime、tool runtime 与大量 builtin tool 划为独立包。[7] | 本项目继续采用“领域端口 → DTO/投影 → 视图”的积木结构；只有在确有协同编辑需求时才评估 CRDT。 |
| 近期知识与文件能力 | AFFiNE 0.26 增加本地索引、CJK 模糊搜索、分块可恢复大附件上传；0.27 继续改善技术内容渲染与稳定性。[3] [4] | LobeHub 的功能目录中将文件树、文件查看、资源库、数据导入、知识库和工作目录拆成独立特性。[6] | P33/P36 必须先补齐“显式选择 → 可恢复导入 → 范围限定检索 → 审查引用”，再讨论语义向量或通用文件系统。 |
| 可靠性与发布 | AFFiNE 近期更新包含 blob 清理、同步队列兼容、任务队列稳定性、懒加载 blob 以避免内存问题，以及客户端体积压缩。[3] [4] | LobeHub 当前发布流同时产出桌面 Canary 与针对 PR 的桌面验证构建；近期修复还覆盖 step-lock 冲突重新入队。[11] | 本项目已有 Windows 候选安装器来源证明；下一阶段须将可靠性重点放在任务重放、导入恢复与资源采样，而不是追逐 Canary 发布频率。 |
| 扩展能力 | AFFiNE 表示插件与第三方 block 仍是演进方向。[1] | LobeHub 提供规模很大的技能/工具生态与相应 marketplace 概念。[5] [7] | 当前 Skill Pack 应保持“纯文本、显式引用、不可授权、可撤销”；绝不将 marketplace 自动安装、通用 shell 或隐式联网引入桌面壳。 |

## 二、当前架构的实证基线

AI Work OS 已经具备与两项参考项目一致的几个关键工程优点：UI 不直连 SQLite、provider 或系统进程；任务页通过类型化工作块与可恢复运行轨迹呈现任务，而不是把证据混入聊天消息；Provider 凭据仅经引用名或当前会话处理；Windows 候选安装器已经通过 GitHub 来源证明验证。现有 Skill Pack 控制面也已经实现 SHA-256 来源 digest、候选/审查/发布/停用/撤销的追加式账本、显式引用、token 上限以及使用时撤销复核。[12] [13]

但这套良好基线进入了新的阶段：**边界已建立，瓶颈开始从“有没有功能”转为“对象吞吐、资源生命周期与控制面可演进性”。** 当前 `gateway-application.ts` 正好 350 行，`App.tsx` 已有 643 行；知识搜索会在每次查询时读取所有向量行、解析每一条 JSON 并在进程内排序；现有 CI 性能检查只约束 Workbench JavaScript、CSS 与 Gateway 文件行数。[8] [9] [10]

| 风险等级 | 瓶颈 | 已有优势 | 根因与影响 |
| --- | --- | --- | --- |
| **P0** | Gateway composition root 饱和 | 有 350 行硬约束，避免无止境增长。 | 新领域服务无法在不违约的情况下装配；临时挤压或删除空白行会制造假合规。必须将 composition 拆成受测试的 feature assembly。 |
| **P0** | 知识检索为 O(N) 内存扫描 | CJK 单字与二元 token、SQLite WAL、确定性评分均已存在。 | 每次查询读取全部向量并解析 JSON，文档/分块增长时 CPU、GC 和首个检索延迟线性恶化；还缺显式可恢复导入管道。 |
| **P1** | 性能门缺少体验指标 | 已限制 JS 500 KB、CSS 150 KB，构建当前分别约 362 KB、88 KB。 | 不能发现“桌面启动变慢、Gateway 就绪延迟、任务事件积压、SQLite p95 变坏、空闲内存上升”等真实回归。 |
| **P1** | Workbench 根协调器偏大 | 页面类型、页面表面与纯投影已分离。 | `App.tsx` 聚集页面切换、Gateway 回调、任务水合与多个二级页面状态；继续加知识/导入流程会增加回归耦合。 |
| **P1** | 导入/资源生命周期不足 | 当前引用预览与本地知识存储可用，文件不会自动扫描。 | 尚没有用户选择文件后的 resumable session、大小预算、来源摘要、取消/失败/续传语义与安全清理收据。 |
| **P2** | 扩展治理从“正确”到“可运维” | Skill Pack 已是纯文本、可审查、可撤销，且不授予能力。 | 仍可增加内容 hash 的独立复算、审查检查清单、来源信任条目及过期复核；不能把这些误解为执行插件机制。 |
| **P2** | 运行数据缺少长期容量模型 | 已有只读运行恢复投影与决策收据。 | 没有明确的事件保留、采样、压缩、导出和 p95/p99 仪表；长任务与大批导入会令诊断数据库持续增大。 |

## 三、可吸收模式与明确不采用项

### 1. 从 AFFiNE 吸收：资源生命周期而非完整编辑器

AFFiNE 的近期价值不在于把 Canvas、Calendar 或 BlockSuite 整体嵌入 AI Work OS。更值得实施的是其本地索引、CJK 体验、可恢复大对象处理、懒加载与清理策略。[3] [4] 因此 AI Work OS 应建立受控的 `KnowledgeImportSession`，将用户明确选择的文件或文本按 `requested → staged → parsed → chunked → indexed → completed | failed | cancelled` 记录为可恢复状态。该对象只保存显示名、大小、SHA-256、可选来源标识、解析统计和用户选择范围；绝不保存绝对路径、API key 或自动扫描结果。

BlockSuite 的“无头 framework 与 UI component 分层”值得作为设计方法，而不值得作为新依赖直接引入。其 CRDT、文档同步和多编辑器复用解决的是多人协作编辑问题。[2] 本项目当前核心问题是单机上一个受控 Agent 任务的可追溯执行，因此使用 SQLite append-only ledger、版本化 DTO 和纯投影会更小、更可靠。

### 2. 从 LobeHub 吸收：任务自治的可见性，而非无边界自动化

LobeHub 将 Agent、任务、项目、文件、审批、模型、工具、记忆和可观测性分拆为特性目录和运行时包，这对本项目的积木式架构是正确参照。[5] [6] [7] AI Work OS 应在本机 Gateway 下继续演进独立领域服务，例如 `KnowledgeImportService`、`RunMetricService` 和 `GatewayFeatureAssembly`；每个服务只有明确的 DTO、账本端口和 HTTP intent 路由。

LobeHub 的云端 7×24 调度、多 Agent 组队、市场化大量技能和远程设备能力不是当前可直接采用的目标。[5] 它们会引入持久后台执行、外部网络与能力升级路径，直接冲突于 Windows 优先、明确审批、固定 loopback Gateway 和不保存密钥的架构铁律。对个人学习产品而言，**可终止、可恢复、可审查** 比“永远在后台跑”更重要。

## 四、建议的优化路线

| 阶段 | 优先级 | 建议交付 | 主要文件/边界 | 验收指标 |
| --- | --- | --- | --- | --- |
| **P35** | P0 | Gateway feature assembly 分解：抽出 `composeProjectFeature`、`composeKnowledgeFeature`、`composeExtensionFeature` 等纯装配模块；root 只做顺序协调与依赖注入。 | `apps/runtime-gateway/src/composition/*`；root 继续禁止直接开端口、读环境变量或创建临时 SQLite。 | root **≤ 220 行**；每个 assembly 有依赖白名单测试；所有现有契约测试通过。 |
| **P35.1** | P0 | 将 Workbench 根协调器拆为 `useTaskWorkspace`、`useProjectWorkspace`、`useWorkbenchNavigation`；页面只接收已水合的 view model 与 intent 回调。 | React hook 位于 `runtime/` 或 `features/`，不导入 SQLite、`node:` 或环境变量。 | `App.tsx` **≤ 420 行**；导航/水合/错误路径各有定向测试；首页不增加复杂管理入口。 |
| **P36** | P0 | 知识导入状态机与范围限定搜索：明确选择来源、可取消/恢复、SHA-256 去重、存储预算、内容摘要、引用版本。 | 新领域服务 + SQLite ledger + Gateway intent + task/settings 二级视图；不扫描磁盘。 | 100 MB 上限可配置；相同 digest 幂等；断点恢复不重复索引；所有返回 DTO 不含路径/正文/密钥。 |
| **P36.1** | P1 | 检索索引演进：保留当前可解释 CJK token 作为 baseline，增加可替换的倒排 postings / FTS5 adapter，并通过 capability probe 决定是否启用。 | `SearchableKnowledgeStore` 端口；原稀疏向量实现仍为兼容 fallback。 | 在 **10,000 chunks**、中英文混合语料上，p95 查询 **≤ 150 ms**、峰值额外堆内存 **≤ 64 MB**；结果与 baseline 的 CJK 回归集保持可解释覆盖。 |
| **P37** | P1 | Windows 性能采样与预算：记录启动四阶段（壳启动、Gateway ready、首屏、可输入）、空闲 RSS、任务事件积压、SQLite 写/读 p95、bundle gzip。 | 只读本地 benchmark harness；CI 保存脱敏 JSON，不上传用户数据。 | 冷启动 p95 **≤ 2.5 s**（定义硬件基线）；可输入 p95 **≤ 3.5 s**；空闲 RSS **≤ 350 MB**；SQLite 常规读写 p95 **≤ 25 ms**；超标阻断 PR。 |
| **P37.1** | P1 | 运行事件容量治理：版本化 span/metric schema、任务级采样、终态压缩、受控保留期、诊断包导出。 | 运行轨迹账本与 observability projection；不得保存 prompt 原文、文件正文、endpoint 或密钥。 | 单 task 的事件增长可预测；保留/删除均形成收据；恢复投影在压缩后仍完整。 |
| **P38** | P2 | Skill Pack 审查强化：独立内容 hash 复算、来源信任条目、审查 checklist、风险标记、过期复核日期和可读 diff。 | 仅扩展纯文本 manifest/ledger；仍禁止动态 import、entrypoint、自动安装和授予工具能力。 | 发布必须同时满足 digest、审查、显式范围；撤销后新旧 injection 都被阻断；恶意指令样本不改变 capability。 |
| **P39** | P2 | 模型决策/成本反馈：将决策收据与运行耗时、token、失败分类关联为只读统计；保持 `canAutoRoute=false`。 | 只读 analytics projection，不产生隐式路由或 API key 持久化。 | 用户可解释“为何使用此 profile”；统计聚合不含 prompt、secret 或完整 provider 响应。 |

上述数值均是本项目建议的验收预算，而非 AFFiNE 或 LobeHub 对外公布的性能承诺。性能基线必须在固定的 Windows 11 x64、内存、磁盘和 CPU 情境下先连续测量多次，再将中位数与 p95 写入仓库；否则指标不可比较。

## 五、建议的实现顺序与风险控制

首先完成 P35 与 P35.1。这不是“重构为了整洁”，而是给 P36–P39 增加独立落点，避免 Gateway root 或 `App.tsx` 继续成为每项能力的唯一改动入口。其后实施 P36/P36.1：先保证导入对象和来源审查正确，再优化检索算法。只有有了真实的导入数据和查询 benchmark，向 FTS5、sqlite-vec 或嵌入模型的迁移才有依据。

P37 应与 P36 并行设计，但性能门只在基线测量稳定后设置为阻断。初期 CI 可先输出报告并在连续三次无异常后改为 hard gate。P38 和 P39 最后推进：它们是治理和可解释性增强，不应抢占导入可靠性、任务恢复或启动性能的工程资源。

| 严格保留的架构铁律 | 原因 |
| --- | --- |
| UI 只订阅事件、发送 intent；不直连 DB、provider、系统进程。 | 这是可测试与凭据隔离的根本，不可为“更快”绕过。 |
| `credentialReference` 只保存引用，secret 不进入 SQLite、事件、DTO、日志或诊断包。 | BYOK 和多 provider 扩张后，泄漏面只会增加。 |
| 首页保持任务发起、项目入口、工作方式和模板；导入、索引、性能与扩展均在任务页/设置页。 | 遵守用户确认的二级信息架构，并保持高频任务入口轻量。 |
| Skill Pack 仅为受审查的文本上下文，不是执行插件。 | 避免把 LobeHub 的生态规模误译为本机无边界执行权限。 |
| Windows x64 优先，候选包继续经过来源证明；CSP 不加入 `unsafe-eval`。 | 桌面安全与可验证发布是当前产品差异化基础。 |

## 参考资料

[1]: https://github.com/toeverything/AFFiNE "AFFiNE GitHub README、架构概述与 MIT 许可"
[2]: https://github.com/toeverything/blocksuite "BlockSuite README：无头 framework、组件边界、CRDT store 与可复用编辑器"
[3]: https://affine.pro/blog/whats-new-july-update-2026 "AFFiNE 0.27.0 官方更新，2026-07-15"
[4]: https://github.com/toeverything/AFFiNE/releases/tag/v0.26.3 "AFFiNE 0.26.3 发布说明，2026-02-25"
[5]: https://github.com/lobehub/lobehub "LobeHub GitHub README、产品定位和许可证"
[6]: https://github.com/lobehub/lobehub/tree/canary/src/features "LobeHub 当前特性目录"
[7]: https://github.com/lobehub/lobehub/tree/canary/packages "LobeHub 当前运行时与工具包目录"
[8]: https://github.com/bear20252026/b07-build/blob/main/apps/runtime-gateway/src/gateway-application.ts "AI Work OS Gateway composition root"
[9]: https://github.com/bear20252026/b07-build/blob/main/packages/knowledge-workflow/src/sqlite-vector-knowledge-store.ts "AI Work OS 本地 CJK 稀疏向量知识存储"
[10]: https://github.com/bear20252026/b07-build/blob/main/tools/performance-budget.mjs "AI Work OS 当前性能预算检查"
[11]: https://github.com/lobehub/lobehub/releases "LobeHub 当前桌面 Canary/PR 构建与近期任务锁冲突修复记录"
[12]: https://github.com/bear20252026/b07-build/blob/main/packages/knowledge-workflow/src/modules/skill-pack/control-plane.ts "AI Work OS Skill Pack 审查与撤销控制面"
[13]: https://github.com/bear20252026/b07-build/blob/main/docs/design/architecture-2026-assessment-and-roadmap.md "AI Work OS 既有架构评估与路线图"
