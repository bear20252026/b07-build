# AI Work OS：P5 后下一阶段研发建议

**作者：Manus AI**

**日期：2026-08-20**
**审查基线：** `main@4e25a62`，136 个自研 TypeScript / TSX / Rust / Python 源文件；已完成 P0–P5 的生命周期硬化、版本化 HTTP 契约、运行轨迹与恢复、受控桌面桥接、四级执行权限、可信桌面 issuer 基础及控制面冷路径诊断。

## 结论

项目当前最值得继续投入的并非再增加一个“万能 Agent”或未经约束的自动化开关，而是将已具备的控制面提升为可组合、可验证、可恢复的**运行时产品层**。建议按照“先降低真实风险，再提高系统组合能力，最后扩展桌面与多 Agent 体验”的顺序推进。

> **核心原则：** 深度插件化应是“可审核的 capability、preset 与 metadata 组合”，而不是“任意第三方代码或浏览器请求可自动加载并获得执行权”。OpenClaw 对 manifest 冷路径、激活规划和能力所有权的划分，以及 DeepSeek-Harness 对 mode 组合的设计，均支持该方向。[1] [2]

## 当前能力与开放差距

| 领域 | 已具备的基础 | 仍然缺失的产品能力 |
|---|---|---|
| 任务执行 | DAG、预算、审批、四级 Authority Mode、恢复快照、append-only trajectory | 输入来源风险分级、可重复的场景评测、运行时 preset 选择器、任务级成本/耗时解释 |
| 扩展生态 | Manifest、activation plan、Extension Doctor、Skill Pack、Agent Adapter 与 Scheduler 控制面 | 构件 provenance、锁文件、兼容性矩阵、可撤销 artifact/quarantine 流程 |
| 本地模型 | Loopback-only registry、健康摘要、Provider Profile、local-first boundary | 模型能力画像、硬件/上下文适配、基准和路由解释、可恢复下载/更新工作流 |
| 知识工作流 | SQLite 索引、检索与引用预览、恢复 bundle | 异步摄取作业、增量版本、取消/重试、embedding migration 和索引健康报告 |
| 桌面体验 | 平台中立 bridge、可信 issuer ledger、冷路径诊断 | 真正 native host 认证、签名、设备 attestation、预加载 API、平台安装/更新链路 |
| 工作台 | 石墨主题、运行轨迹、扩展中心、模型健康、控制面诊断 | 多 Agent board、统一审批收件箱、错误恢复 UX、组件/a11y/视觉回归测试 |

## 优先级矩阵

评分采用 1–5 分：**价值**表示对个人学习 Work OS 的长期杠杆；**风险降低**表示对错误执行、数据丢失或供应链风险的缓解；**复杂度**越高表示实施更重。优先级由价值、风险降低与前置依赖共同判断，而不是单看功能吸引力。

| 优先级 | 建议 | 价值 | 风险降低 | 复杂度 | 前置依赖 | 可验证完成条件 |
|---|---|---:|---:|---:|---|---|
| **P6.0** | 输入 provenance 与不可信内容隔离 | 5 | 5 | 3 | 现有 trajectory、Policy、Profile | 每个 web/file/email/document input 携带来源与信任标签；不可信内容默认只能由 reader profile 处理；跨到写入/Shell/浏览器需显式 declassification approval。 |
| **P6.1** | 本地 Security Posture Audit | 5 | 5 | 3 | P5 control-plane diagnostics | `GET` 只读审计、CLI/桌面本地触发；检查 loopback/bind、权限漂移、未受信 extension、过宽 capability、过期租约、数据库权限与恢复健康；结果可重开审查。 |
| **P6.2** | Extension/Skill 构件 provenance 与 lockfile | 5 | 5 | 3 | Manifest、Skill Pack、SQLite revisions | 每个可激活构件绑定 digest、来源、许可证/版本、审查结论与 lock revision；digest 变化自动阻断 activation，而不是静默升级。 |
| **P7.0** | Runtime Preset 组合层 | 5 | 4 | 4 | Extension plan、Profile、Authority、Scheduler | `RuntimePresetManifestV1` 只引用已审核 model/tool/skill/session/storage/sandbox/loop；resolver 生成不可执行 activation plan 与解释；任何缺失/越权 capability 都失败关闭。 |
| **P7.1** | 场景化 Agent Evals 与回放测试 | 5 | 4 | 4 | Trajectory、task contracts | 固定 fixture 覆盖 prompt-injection、超预算、失败恢复、审批拒绝、provider 不可用和插件漂移；每次 CI 输出确定性评分及差异。 |
| **P7.2** | Provider Capability Card 与路由解释 | 4 | 3 | 3 | Provider Profile、health registry | 明确文本/视觉/embedding/tool/structured output/context/hardware 等画像；UI 显示“为何选择/排除模型”，无 URL/secret 泄露。 |
| **P8.0** | 知识摄取 Job 与索引版本迁移 | 5 | 4 | 4 | Knowledge workflow、recovery bundle | 摄取可取消、可重试、可量化；citation 展示 source/ingest/index revision；迁移先模拟后切换，旧索引可回滚。 |
| **P8.1** | 多 Agent 任务板与统一审批收件箱 | 4 | 3 | 4 | Adapter、Schedule、Trajectory | 按 agent/run 展示独立 context、预算、状态和审批；队长只创建 metadata delegation，不能直接扩大队员权限。 |
| **P8.2** | Workbench a11y、交互与视觉回归 | 4 | 3 | 2 | 现有 React 工作台 | 替换全局 DOM 查询为 ref；键盘流、焦点、屏幕阅读器、窄屏、错误态与主题均有组件或浏览器测试。 |
| **P9.0** | 可信 native desktop host | 4 | 5 | 5 | P5 issuer registry、Rust supervisor | OS 会话认证、最小 IPC、一次性 challenge、短时 proof、签名升级/撤销、平台权限映射；renderer 不能自证身份。 |
| **P9.1** | 本地模型运行资源与交付体验 | 4 | 3 | 5 | Provider capability card、Rust supervisor | 模型下载、校验、磁盘配额、硬件 suitability、启动/停止与 GPU 诊断都经 host control plane；不由浏览器直接执行。 |

## 建议立即实施的 P6：安全保证层

### 1. 输入 provenance、taint 与 reader handoff

这是下一项**最高价值**工作。当前系统已正确把执行能力限制在 policy、Profile、Authority Mode 和审计边界内，但尚未将“模型看到的信息来自哪里、是否不可信、能否驱动高影响工具”建模为一等协议对象。

OpenClaw 的安全文档明确将网页、邮件、附件、文档、粘贴日志和工具结果都视为潜在不可信内容，并建议把高风险内容交给工具受限的 reader agent，再将受控摘要移交给主 Agent。[3] 本项目应借鉴其**输入来源优先于提示词防御**的思路，而不复制其任何宽松执行配置。

建议新增 `InputProvenanceV1` 与 `ContentTrust`：`operator-authored`、`workspace-controlled`、`external-untrusted`、`derived-untrusted`。任何来自 fetch、browser、upload、knowledge ingestion 或外部 adapter 的文本都默认带 `external-untrusted`。`TaintAwareCapabilityPolicy` 必须在既有 Profile / Authority Policy 之后再收紧：当 task context 包含不可信输入时，`filesystem.write`、`shell.execute`、`browser.control`、`network.fetch` 均要求独立 declassification approval；`plan` 与 reader profile 仍可进行只读分析。trajectory 只记录摘要、来源种类和 digest，永不写入原文。

验收应包括：恶意网页、恶意 PDF 文本和伪造 tool result fixture 无法通过“忽略规则”类文本触发写入或执行；授权操作者可以显式批准经 digest 绑定的有限 handoff；恢复任务不能丢失或降低 taint。

### 2. Security Posture Audit：从诊断面变成安全基线

P5 已有冷路径控制面诊断，下一步应新增独立的 `SecurityPostureAuditService`，而不是让 Workbench 自行拼凑风险判断。OpenClaw 将 inbound、工具 blast radius、执行审批漂移、网络暴露、插件 allowlist、sandbox 预期落差和本地磁盘卫生集中为结构化 check ID，并把安全修复限制为可验证的窄操作。[3]

本项目的 audit 结果应是 append-only `SecurityFindingV1`，字段限定为 `checkId`、`severity`、`subjectKind`、`subjectId`、`evidenceDigest`、`remediationHint` 与 `checkedAt`。第一版只检查本地控制面：未审查/撤销却被引用的 extension、profile 的 remote 边界与任务要求不一致、失效/过宽管理员租约、缺失 restore drill、未通过 health 的 local model、强制资源隔离不可用、数据库/备份路径权限异常。审计**不自动修复、不升级 Authority、不启动 extension**。

### 3. Supply-chain provenance、quarantine 与锁定快照

OpenClaw 的插件架构强调 manifest 冷路径、元数据快照与 activation plan；其安全指南也将“未显式信任的插件加载”视为供应链风险。[1] [3] 当前项目已有 manifest、digest 和审查状态，但仍值得把 Extension、Skill Pack、Adapter 与未来 preset 统一到一个 `ArtifactProvenanceV1`。

建议实现不可变 `artifactId + version + digest + source + reviewedRevision + dependencyDigest[]`，并新建 `ControlPlaneLockV1`。某运行时 plan 只引用 lock 中的确定构件版本；发现相同 ID 但 digest 变化时进入 `quarantined`，不更新、不激活、不删除旧版本。这样既保留 DeepSeek-Harness 的“可替换组合”，又避免把“插件化”等同于“自动下载/自动运行”。[2]

## P7：把“Everything is a plugin”本地化为 Runtime Preset

DeepSeek-Harness 将模型、工具、技能、session、sandbox、storage、loop、schedule 与 UI 都视为可替换插件，并用多个运行模式表达组合。[2] 对本项目最适合的借鉴不是复制其内存中装载或通用模式，而是新增只读、版本化、可审查的 `RuntimePresetManifestV1`。

| Preset 字段 | 约束 |
|---|---|
| `modelProfileId` | 必须引用 active 且符合 data boundary 的 Provider Profile。 |
| `skillPackIds` / `extensionIds` | 必须都已审查并在 lockfile 内；仅形成激活计划，不加载 runtime。 |
| `loopId` / `storageId` / `sandboxProfileId` | 只能从核心 allowlist 选择，不能指向任意模块路径。 |
| `authorityCeiling` | 只能收紧，不得高于提交任务时的 Authority Mode、Profile 或可信租约 scope。 |
| `resourceBudget` | 作为请求值记录；没有 OS enforce adapter 时 UI 明示为 requested-only。 |
| `diagnosticPolicy` | 声明必须通过哪些 audit check 才能变为 ready。 |

该模式也与 OpenClaw 的“plugin 是所有权边界、capability 是核心合同”相符：Provider/feature 插件不能被各页面直接耦合，消费者只读取稳定 capability。[1] 首个版本只应提供三个内置 preset：`research-reader`、`local-build-reviewed`、`offline-knowledge-curator`，均默认拒绝任何未声明能力。

## P8：知识与协作体验

### 知识摄取作业和向量迁移

AnythingLLM 明确提醒，向量数据库切换并不会自动迁移已嵌入资料，使用者需要重新嵌入；这验证了向量索引必须拥有显式 version、迁移和回滚，而不是一个隐藏设置。[4] 本项目应先做 `IngestionJob`，再考虑更多 vector backend：每个 job 保存 source digest、parser revision、chunker revision、embedding profile、index revision、进度、取消理由和可重试错误类别。citation 需要显示对应 ingest/index revision；迁移必须先创建影子索引，完成抽样校验后才切换 read alias。

### 多 Agent board，而不是多 Agent 全自动

AionUi 的 leader/teammate、独立 context、异步 mailbox、共享任务板与逐 Agent 审批对 Workbench 有很高参考价值。[5] 但本项目应让 leader 只能提交有界子任务 intent，不能把自身权限或管理员租约传给 teammate。每个 run 保持独立预算、Profile、Authority Mode、taint state 与 trajectory；共享文件仅通过 workspace scope 和 citation/diff 交接。先完成统一视图和审批收件箱，再评估并发调度扩张。

## P9：桌面和本地模型的真正产品化

Jan 的 Tauri + Rust 结构、离线模型/云模型并存、OpenAI-compatible local server 和 MCP 支持，说明“本地优先”既需要 runtime 能力，也需要分发、硬件与诊断体验。[6] Chatbox 的 `main / preload / renderer / shared` 分层则提供了 Electron 版本的清晰进程边界与跨平台测试参考。[7] 因此 P9 应以 P5 的 issuer registry 为唯一入口建设 native host：浏览器 renderer 永远不拥有认证证明、文件系统、进程句柄或 model download 权限。

只有当 P6 audit、P7 preset、P8 knowledge job 稳定后，才建议加入本地模型下载/启动、GPU suitability、文件预览、窗口多开及签名更新。否则复杂桌面功能会提前把安全和可恢复性债务推入 UI。

## 建议的连续实施顺序

| 里程碑 | 建议交付 | 退出条件 |
|---|---|---|
| **P6** | Provenance/Taint、Security Posture Audit、Artifact Provenance/Lock | 不可信输入不能跨越执行边界；审计可重开；构件 drift 可阻断。 |
| **P7** | Runtime Preset、Agent Evals、Provider Capability Card | preset 只生成解释性计划；CI 有安全/恢复/路由回归场景。 |
| **P8** | Ingestion Job、Index Migration、Multi-Agent Board、a11y suite | 知识可取消/重试/回滚；多 Agent 的预算/权限/轨迹不串扰。 |
| **P9** | native host 认证、最小 bridge、桌面分发与本地模型体验 | 原生认证才能签发管理员 lease；renderer 无系统执行能力。 |

## References

[1]: https://docs.openclaw.ai/plugins/architecture "OpenClaw Plugin Architecture"
[2]: https://deepseek.com/harness/en/ "DeepSeek Harness: Everything is a Plugin"
[3]: https://docs.openclaw.ai/gateway/security "OpenClaw Gateway Security"
[4]: https://docs.anythingllm.com/setup/vector-database-configuration/overview "AnythingLLM Vector Database Configuration"
[5]: https://github.com/iofficeai/aionui "AionUi Repository"
[6]: https://github.com/janhq/jan "Jan Repository"
[7]: https://github.com/chatboxai/chatbox "Chatbox Repository"
[8]: https://github.com/CherryHQ/cherry-studio "Cherry Studio Repository"

Cherry Studio 的多 Provider、本地模型、MCP、文档处理和跨平台桌面结构同样是 P7–P9 的备选体验参考；其价值应通过本项目的 Provider Capability Card、Workbench 能力边界和可访问性测试吸收，而不直接将其桌面权限模型搬入浏览器层。[8]
