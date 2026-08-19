# 由账号2生成
<!-- file-id: acct2-20260819-tauri-phenomenon-implplan ; 作者: 账号2 ; 日期: 2026-08-19 -->

# "AI 工作操作系统" · 融合型商业级桌面 AI 产品 · 实施方案

> 依据：①Manus AI《2026年8月构建现象级桌面AI产品的架构研究与代码路线》(桌面文件) ②本账号《AI执行桌面端-Tauri现象级架构定稿》③用户提供的《融合型商业级桌面 AI 产品执行蓝图》④对 AgentForge / OpenWorker / cc-switch 三仓库的实测核实。
> 三份方案技术栈完全一致（Tauri 2 + Rust 控制面 + React/TS 工作台 + TS Agent/MCP + Python 重计算 sidecar + SQLite 事件日志），本方案把它们融合为一套可执行的工程蓝图。

## 一、产品定义与第一性原理

**不是**“更大的 Chatbox / OpenClaw / 多 Agent 集成窗”，而是——

> 一个本地优先、云端可协作、能跨文件/浏览器/软件/业务系统持续完成任务、并交付**可编辑成果**的 **AI 工作操作系统**。

第一性原理：`Outcome → Plan → Execute → Review → Deliver → Learn`，而不是 `Message → Response`。

## 二、统一产品内核（一切能力落入同一套领域对象）

所有参考产品的能力不再以独立功能页存在，统一映射到以下领域对象：

`Workspace · Task · Plan(DAG) · Agent · Skill · Tool(MCP/Connector) · Artifact · Approval · Memory · Schedule · UsageEvent`

**Agent 不是 while 循环**，而是分层流水线：

```
Task Intake → Intent Normalizer → Planner/DAG Builder → Policy Evaluator
  → Expert Router → Execution Scheduler → Tool Runtime/Connector/Browser/File Worker
  → Reviewer → Artifact Composer → Human Approval or Delivery
```

每个动作产出**结构化事件**，带超时/重试/幂等键/输入摘要/输出引用/风险等级/审批要求/回滚策略。UI 只订阅事件+发用户意图，不改内部状态。

**事件日志=黑匣子**：保存计划、工具调用、审批、文件 diff、浏览器动作、模型选择、失败原因、重试、产物引用 → 支持任务恢复/过程解释/成本分析/质量评估/客服排障/企业审计/用户信任。

## 三、技术架构与三语言职责边界（对应原任务 #3）

```
┌──────────────────────────────────────────────┐
│ Surfaces: Desktop / Web / CLI / 渠道 / API   │
└───────────────┬──────────────────────────────┘
                │ Versioned Events + Commands
┌───────────────▼──────────────────────────────┐
│ Local Gateway / Cloud Gateway                │
│ Task API · Session · Auth · Policy · Events  │
└───────┬──────────────┬──────────────┬────────┘
  Agent Runtime    Capability Host  Artifact Service
  Planner/DAG      MCP/Connectors   DOCX/PPTX/HTML
┌───────▼──────────────▼──────────────▼────────┐
│ Execution Plane                               │
│ Rust sandbox · browser bridge · file worker  │
│ Python document/RAG sidecars · model workers │
└──────────────────────────────────────────────┘
```

### 语言分工表（只做这些，别越界）

| 层 | 技术 | 职责上限 | 参考 |
|---|---|---|---|
| 桌面壳/本地控制面 | **Tauri 2 + Rust** | 窗口/生命周期/更新/崩溃恢复/子进程监督/权限/密钥/vault/capability token/沙箱协调/进程内代理/SQLite | cc-switch + OpenWorker + AgentForge |
| 产品工作台 | **React + TS + Vite** | 任务时间线/审批/文件树/浏览器/Artifact 编辑/命令面板；只订阅事件不发直接状态 | Cherry/Lobe UI |
| Agent 编排 | **TypeScript** | Planner/DAG/Tool Schema/MCP/Provider adapter/事件协议/插件 SDK | CoreCoder + ClawCode + dsh |
| 文档重计算 | **Python sidecar** | PDF/DOCX/PPTX/OCR/Embedding/RAG/语音/本地模型 — 高变化迭代快的下沉 | OpenWorker + AnythingLLM |
| 本地数据 | SQLite + migrations | workspace/task/event/artifact 元数据/provider profile | cc-switch |
| 云端 | TS/Rust 服务 | 租户/同步/协作/账单/审计/队列/模型网关/Marketplace | Open WebUI/AnythingLLM 企业 |

**核心判断：Rust 做安全与边界，TypeScript 做产品与生态，Python 做高变化 AI 能力——任何语言都不独自承担全部职责。**

### 统一通信协议（JSON-RPC / Event Stream，语言无关）
1. 前端→Rust（系统能力）：`tauri invoke` + Event（窗/权限/STT/更新/崩溃）
2. 前端→TS 编排→sidecar（业务）：HTTP/SSE 流式 + WS 事件流；Rust 注入 `__API_TOKEN__` 全局，REST header / WS subprotocol 鉴权
3. TS→Rust：JSON-RPC 事件上报（可审计/可恢复）
4. TS→Python（重计算）：JSON-RPC over 本地 HTTP/WS；事件 schema 用 JSON 跨三语共享
5. 安全边界：一律绑定 `127.0.0.1`，token 401，CORS 固定 webview，临时短生命周期 token，凭证不进 renderer/URL/日志/prompt

### 参考目录

```text
apps/    desktop/ workbench/ gateway/ admin/
packages/ protocol/ agent-runtime/ provider-sdk/ mcp-host/
          connector-sdk/ artifact-sdk/ ui-kit/ test-fixtures/
crates/  control-plane/ security/ filesystem/ process-runtime/
          browser-bridge/ updater/
sidecars/ document-worker/ retrieval-worker/ speech-worker/
services/ cloud-gateway/ usage-ledger/ artifact-service/ marketplace/ admin-service/
migrations/ sqlite/
docs/    rfcs/ threat-model/ decisions/
```

### ModelRouter 与通用接口
- 接口收敛：①OpenAI Chat Completions ②Anthropic Messages ③Gemini ④自定义 OpenAI 兼容端点 ⑤Responses API(可选) ⑥LiteLLM 兜底
- 每个 Provider 实现 `ModelDriver`；`ModelRouter` 按任务类型/延迟/成本/能力/数据策略/用户规则选模型
- 能力矩阵声明 `ModelCapability`（modalities/supports/contextWindow/pricing/dataPolicy）
- Rust 进程内代理做统一网关：模型路由/故障转移/多 key 轮换（cc-switch axum 式）

## 四、权限模型与安全边界（从第一天起）

**默认本地、最小权限、显式能力、审批高风险动作、可撤销、可审计、可恢复。**
- 文件仅限 workspace；终端用临时目录/环境白名单/超时/资源限制；网络域名 allowlist；浏览器只暴露 active tab；MCP server 默认不信任；插件需来源/权限声明/签名校验
- **模型输出是非可信输入**：所有工具参数过 JSON Schema + 业务规则 + 路径规范化 + 域名校验 + 权限策略；"说自己完成"须由工具结果/Artifact 状态证明
- 凭据由 Rust vault 管理，发放短生命周期 capability token
- **许可证隔离 + SBOM**：核心商业代码/宽松依赖/强 copyleft 依赖/参考源码分边界；GPL/AGPL 不直接复制进闭源核心；保留架构笔记/独立 API/独立测试/提交历史/依赖清单/代码生成来源的清洁实现证据

## 五、差异化：不要功能最多，要"可靠完成工作"

商业壁垒 = **任务可靠性**，不是连接器数量。为每个任务引入质量指标：计划完成率、首次成功率、人工接管率、工具错误率、平均重试次数、产物可编辑率、事实引用覆盖率、用户修改距离、单位任务成本、节省时间。

| 任务类别 | 成功标准 |
|---|---|
| 深度研究 | 来源可追溯/结论有引用/结构清晰/报告可交付 |
| 数据分析 | 数值正确/图表可复算/过程可审计/文件可编辑 |
| PPT/DOCX | 内容一致/版式稳定/素材可替换/可继续编辑 |
| 文件整理 | 只动授权目录/动作可预览/可撤销/无误删 |
| 浏览器操作 | 目标站点明确/关键动作确认/状态可回放 |
| 编码任务 | 修改可审查/测试自动跑/失败可恢复/差异可回滚 |
| 自动化任务 | 可调度/可暂停/失败告警/结果可追踪 |

## 六、实施路线图（12 个月，分 5 阶段落地）

**阶段 0（2 周）产品真伪测试**：选研究报告/文件夹整理/销售数据分析 3 个高频可量化任务，用人工+少量脚本验证用户愿为"完成结果"付费。指标：完成时间、返工时间、首次成功率、愿意支付的价格。

**阶段 1（6–8 周）本地可信核心**：Tauri/Rust 控制面 + React 工作台 + SQLite + 事件协议 + Provider Registry + 文件 workspace + 审批 + Artifact 管理 + 基础测试。交付标准：任务可中断/恢复/回放/撤销。MVP 范围=2 云端 provider+1 本地入口；1 Supervisor+3 Experts(Research/File/Document)；工具=workspace 文件/只读网页搜索/受限终端/单 active tab；交付=MD/DOCX/PPTX/CSV/HTML。

**阶段 2（3 个月）Cowork 闭环**：Task DAG + Research/Document/Spreadsheet Experts + 浏览器 active tab + DOCX/PPTX 输出 + 成本统计 + 定时任务 + 结果分享。重点提高首次成功率与交付物质量，不加 Agent 数量。

**阶段 3（6 个月）生态与团队**：MCP/Connector SDK、Skills/Experts 版本化、插件权限、Marketplace、团队 workspace、RBAC、审计、配额、组织级 Provider Router、私有部署。插件生态建立在稳定协议+安全审核上，不简单让任意代码加载。

**阶段 4（12 个月）平台化**：消息入口、移动远程控制、企业身份 SSO/SCIM、OpenTelemetry、云同步、模型评测、任务质量评分、行业模板 → 三层产品（个人工作台+团队操作系统+开发者能力市场）。

## 七、工程治理

| 领域 | 写法 |
|---|---|
| TypeScript | strict:true，禁隐式 any，跨进程数据 JSON Schema 校验，domain/UI 分包 |
| Rust | workspace+小 crate，clippy 严格，thiserror/结构化 error code，不在 command 层吞错 |
| IPC | 只传版本化 command/event，不传任意函数/未校验对象/持久化 token |
| Agent | 每 tool 有 schema/权限/风险级别/超时/幂等键/测试 fixture |
| 数据库 | schema 变更迁移化，事件 append-only，禁止 UI 直接拼 SQL |
| 测试 | 单测、协议契约测试、无真实网络 agent replay、跨平台 E2E、安装升级测试 |
| 发布 | macOS 签名+notarization、Windows 代码签名、Linux AppImage/deb、自动更新可回滚 |
| 观测 | 本地默认脱敏日志；同意后匿名崩溃/性能；企业版 OpenTelemetry |
| 文档 | 重大设计写 RFC/威胁模型/决策记录；插件 API 版本化 |

## 八、商业模式与增长机制

**不卖单模型调用**（模型降价且同质化）。价值来自：团队治理/企业私有部署/工作流模板/行业 Experts/连接器/审计合规/成本控制/Artifact 协作/高成功率执行。

| 版本 | 价值 | 收入 |
|---|---|---|
| Local Free | 本地聊天/基础文件/少量模型 | 获客入口 |
| Pro | 长任务/更多额度/文档PPT/自动化/模型路由 | 个人订阅 |
| Team | 共享 workspace/Skills/Expert/RBAC/预算/审计 | 席位 |
| Enterprise | 私有部署/SSO/VPC/合规/SLA/数据治理 | 年度合同 |
| Marketplace | Skills/Experts/Connectors/模板 | 抽成/开发者订阅 |
| Model Gateway | BYOK/智能路由/成本优化/统一计费 | 用量/平台费 |

**现象级增长机制**：用户完成任务→得到可分享成果→他人复制 Task Recipe→组织建共享 Expert→团队产生更多任务数据→产品靠质量反馈更可靠。增长点是"我用一句话完成了一个可交付项目"，不是聊天截图。

## 九、最终判断

不要做"所有产品代码拼在一起的超级客户端"，而要做**所有优秀能力共同依赖的统一内核**——让不同模型/Agent/工具/桌面入口/企业系统共享同一套 Task、Event、Policy、Artifact 协议。

- 技术路线：**Tauri 2 + Rust Local Control Plane + React/TS Workbench + TS Agent/MCP SDK + Python Document/RAG Sidecars + Cloud Multi-tenant Gateway**
- 产品路线：先用三个高价值任务证明结果交付 → 再 Cowork → 再团队生态 → 最后平台
- 避免：复制全部源码、同时支持所有模型/连接器、首发就上多 Agent 全自动电脑控制、靠功能数量堆出商业奇迹

**商业奇迹 = 清晰任务闭环 × 可靠执行质量 × 安全权限模型 × 可持续生态 × 可量化商业价值。** 第一步行动：建立 todo，把阶段 0 三任务 + 阶段 1 核心回环作为首个冲刺交付。

## 十、下一步可执行动作（拆到可直接开工）
1. 初始化 pnpm workspace + Rust workspace，搭 `apps/desktop`+`apps/workbench`+`crates/control-plane` 空壳
2. `packages/protocol` 先定 `TaskEvent`+`CapabilityPolicy`+`ModelCapability` JSON Schema 与 TS 类型（唯一事实源）
3. `crates/control-plane` 落地：窗口/生命周期/子进程监督（拉起 Python sidecar、随父自杀、日志）+ SQLite 迁移
4. Python `sidecars/document-worker` FastAPI 骨架（127.0.0.1 + token 鉴权 + WS）
5. `packages/agent-runtime` 最小 DAG 执行器 + 2 Provider adapter + 单 active tab 浏览器桥
6. React 工作台：任务时间线 + 审批窗 + 文件树 + Artifact 列表
7. 契约测试 + 无真实网络 replay fixture，打通阶段 1 闭环

—— 本方案为三份输入方案的融合定稿，可直接作为工程开工蓝图。 ——
