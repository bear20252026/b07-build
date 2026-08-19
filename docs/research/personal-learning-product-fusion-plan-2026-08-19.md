# AI Work OS：个人学习产品能力融合计划

**版本**：v0.13.0 规划稿  
**日期**：2026-08-19  
**目标**：以 OpenClaw 的本地优先、会话恢复与控制面为最高优先级，吸收 OpenCode、DeepSeek Harness、ClawCode、AionUi、OpenWorker、AnythingLLM、5ire、Jan、Cherry Studio 等公开项目中可验证的设计模式，构建可理解、可验证、可恢复的个人学习系统。

> 该计划采用“领域契约优先、实现可替换、能力默认拒绝、UI 只发意图和订阅事件”的积木式原则。参考项目只提供问题拆分和架构启发；本项目保持独立命名、测试和实现。

## 能力融合矩阵

| 学习产品能力 | 优先参考模式 | AI Work OS 当前状态 | v0.13–v0.15 独立落点 | 优先级 |
|---|---|---|---|---|
| 本地会话与隐私模式 | OpenClaw：Gateway-owned session、durable/incognito、SQLite 维护 | 已有可恢复任务 SQLite 快照，尚无独立会话元数据 | `SessionControlPlane`、`SessionScope`、durable/ephemeral/incognito、state version、archive/pin/reset | P0 |
| 控制面与可靠事件 | OpenClaw typed gateway；ClawCode Rust control plane | HTTP loopback gateway、TaskEvent、Rust scheduler stats IPC | 版本化 session/task control DTO、幂等收据、gap 后 snapshot refresh；后续 WS/JSON-RPC adapter | P0 |
| Agent 角色与子任务 | OpenCode primary/subagent；OpenClaw agent isolation | Build/Plan/Explore Profile 仅能收紧权限 | 独立 `AgentRole`、只读 Explore/Scout 子任务、父子快照和摘要引用；不将 Profile 误作 persona | P1 |
| 可组合运行时 | DeepSeek Harness service seam 与 append-only 轨迹 | Provider、Store、Policy 已有独立端口 | `RuntimePresetManifest`：封闭配置快照，声明 mode/role/profile/budget/adapter；不接受动态任意插件代码 | P1 |
| 本地模型与路由 | Jan 本地运行；Cherry Studio 多模型；OpenCode per-agent model | 能力/成本/本地性打分 Router，已有 local adapter | `LocalModelEndpointRegistry`：健康、能力、版本、上下文窗口与 offline 状态；UI 显示解释性选择 | P1 |
| 知识工作区与引用 | AnythingLLM workspace；5ire local RAG；Open WebUI hybrid pipeline | SQLite 稀疏向量、来源引用、工作台预览 | Knowledge Workspace、source scope、retrieval plan；先 lexical/vector 混合与可解释排序，后接 reranker adapter | P2 |
| MCP 与外部工具 | 5ire MCP client；Open WebUI tools/MCP | Capability policy、审批工具 Runner | MCP registry manifest、信任状态、能力摘要和 explicit enable；禁止自动安装/执行未知 server | P2 |
| Cowork 体验与生产力 | AionUi persistent tri-pane；LobeHub/Chatbox session UX | 真实任务、审批、引用预览、石墨主题 | 会话列表、任务树、引用到产物追溯、恢复入口；保持桌面本地优先 | P2 |
| 评估与可观测性 | DeepSeek trajectory；OpenWorker 长任务运营 | DAG stats、事件与快照 | 运行回放、预算燃尽原因、基准历史、可导出脱敏运行记录 | P3 |

## 版本路线

| 版本 | 核心交付 | 学习价值 | 验收标准 |
|---|---|---|---|
| **v0.13** | Session Control Plane v1 + SQLite session metadata + incognito 语义 | 理解本地持久化、隐私边界、快照版本与事件恢复 | durable 可重开；incognito 不进入 session store / knowledge index；UI 只读取防御性 DTO |
| **v0.14** | Session/Task Control Gateway v1 + 幂等键 + snapshot gap refresh | 理解可靠本地控制协议 | 重复 submit/approve 不创建重复副作用；版本间隔后客户端刷新 snapshot |
| **v0.15** | 只读 Subtask v1 + Runtime Preset Manifest | 理解父子任务、预算隔离与可组合运行时 | Explore/Scout 子任务不能写入或执行；父任务只消费摘要/引用；preset 不可越权 |
| **v0.16** | Local Model Endpoint Registry + Workspace Knowledge Scope | 理解本地模型服务探测与可解释检索 | 本地 endpoint 下线自动排除；每次知识命中可说明工作区、来源和排序理由 |
| **v0.17** | MCP Registry Manifest + 工作台会话/任务树 | 理解扩展信任边界和生产力 UI | 未批准 MCP 无法执行；扩展状态、风险和审批记录可回放 |

## 本轮实施决定

立即进入 **v0.13：Session Control Plane v1**。它解决个人学习产品最基础的会话恢复、隐私和控制状态问题，也是后续 Agent 隔离、子任务、知识范围和可靠 Gateway 都依赖的事实来源。

### 不变量

1. `AgentProfileId` 不是 persona、session 或 workspace 的隔离键。
2. 浏览器不读取 SQLite，不保存 session transcript，也不决定任何工具权限。
3. `incognito` 不进入持久 session store 或知识索引；工具产生的外部副作用仍由独立策略与审计边界管理。
4. Session 事件/快照版本只能追加；重新连接时客户端读取最新 snapshot，不以 UI 内存猜测状态。
5. 任何角色、preset、adapter 或 MCP manifest 都不能将默认拒绝能力放宽。

## 研究来源

1. [OpenClaw Gateway architecture](https://docs.openclaw.ai/concepts/architecture)
2. [OpenClaw Session management](https://docs.openclaw.ai/concepts/session)
3. [OpenClaw Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent)
4. [OpenCode Agents](https://opencode.ai/docs/agents/)
5. [OpenCode Permissions](https://opencode.ai/docs/permissions/)
6. [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
7. [5ire](https://github.com/nanbingxyz/5ire)
8. [Open WebUI & AnythingLLM](https://docs.openwebui.com/alternatives/anythingllm/)
9. [Open WebUI & Jan](https://docs.openwebui.com/alternatives/jan/)
