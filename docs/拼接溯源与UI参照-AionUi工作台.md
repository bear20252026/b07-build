# 由账号2生成
<!-- file-id: acct2-20260819-splice-provenance-ui ; 作者: 账号2 ; 日期: 2026-08-19 -->

# 《拼接溯源 + UI 参照》——每个拼接块来自哪个程序 + 工作台按 AionUi 参照

> 配套：《拼接代码总纲-积木式最小工程.md》。本文件回答两件事：
> ①**每段拼接代码源自哪个真实开源项目**（含仓库内精确定位），做到"抄在哪、抄什么"一目了然；
> ②**产品 UI 页面参照 AionUi**，按积木铁律把 AionUi 的布局/面板/组件融入我们的工作台（React/TS）。
> 出处均取自本地镜像原仓库（OpenWorker / AgentForge / cc-switch / DeepSeek-Harness / CoreCoder / AionUi），已核证。

## 一、逐项溯源表：《拼接代码总纲》每块代码 ← 真实项目

| 代码块 | 在《总纲》的位置 | 拼接自 | 真实文件/定位 | 抄的核心机制 |
|---|---|---|---|---|
| **A. Rust 子进程监督** | 第二节-A (`supervisor.rs`) | **OpenWorker + AgentForge** | OpenWorker `src-tauri`（spawn Python server、注入 env、随父自退）；AgentForge `src-tauri/src/lib.rs` 第 20–28 行（`app.shell().sidecar("agent-forge-server")` + `envs` 注入 `AGENT_FORGE_DATA_DIR`）、第 44–50 行（Windows `taskkill` 退出清理） | 拉起 sidecar + 注入 token/端口 env、`CREATE_NO_WINDOW`、`EXIT_WITH_PARENT`、退出回收 |
| **B. Rust 凭证 Vault** | 第二节-B (`vault.rs`) | **OpenWorker 鉴权思路** → 本地化 | OpenWorker `coworker/server/app.py` 第 184 行 `secrets.compare_digest(provided, api_token)`（常量时间比较） | 短生命周期 token、常量时间比较防时序侧信道、明文不回显 |
| **C. Rust 进程内代理** | 第二节-C (`gateway.rs`) | **cc-switch** | cc-switch `src-tauri/src/proxy/forwarder.rs`（axum `ProviderRouter` + `FailoverSwitchManager` 故障转移 + `app.emit("provider-switched")` 事件） | 127.0.0.1 本地代理、模型路由、故障转移、provider 切换事件 |
| **D. TS DAG 执行器** | 第三节-D (`executor.ts`) | **DeepSeek Harness + CoreCoder** | DeepSeek-Harness（Everything is a Plugin、DAG 化任务编排）；CoreCoder `agent`（for 上限+中断回填思路） | 节点=一种作用、幂等键、预算、事件发射（Emit） |
| **E1. ModelDriver 端口** | 第三节-E (`driver.ts`) | **统一 Provider 抽象（多项目共识）** | 多项目共同模式：DeepSeek-Harness Provider、Jan OpenAI-compatible、OpenWebUI、CoreCoder provider | 稳定 port 接口：chat(stream) + id() |
| **E2. OpenAI adapter** | 第三节-E (`adapters/openai.ts`) | **AgentForge 手写 SSE** | AgentForge `src/api/client.ts`（`fetch` + **SSE 流式**解析 `data:` 行、`[DONE]` 终止）；协议兼容 OpenAI Chat Completions | SSE 流式 fetch 解析、`[DONE]`、增量 delta 内容 |
| **E3. ModelRouter** | 第三节-E (`router.ts`) | **cc-switch / AnythingLLM / 多项目** | cc-switch ProviderRouter；AnythingLLM 动态路由；Manus 报告的 `ModelRouter` | 按任务类型/成本/能力选模型 |
| **F. Python FastAPI+token** | 第四节-F (`app.py`) | **OpenWorker** | OpenWorker `coworker/server/app.py` 第 187–204 行：`_websocket_authenticated`（`sec-websocket-protocol` subprotocol + `secrets.compare_digest`）+ `require_sidecar_token` middleware（`X-OpenWorker-Token`、CORS `allow_origin_regex` 固定 webview、401） | REST header + WS subprotocol 双通道 token 鉴权、401 |
| **G. 文档处理 processor** | 第四节-G (`processor.py`) | **AnythingLLM collector（思路）** | AnythingLLM 文档 ingestion/collector（PDF/DOCX/PPTX 解析、embedding 入向量库）；这里只保留"纯处理、无网络/无鉴权"的积木切分 | 文档→结构化文本+元数据，不进 HTTP、不碰网络 |

> 一句话原则：**Rust 监督+代理=OpenWorker+AgentForge+cc-switch；TS 编排=DeepSeek-Harness+CoreCoder+统一协议；Python=OpenWorker 鉴权 + AnythingLLM 文档管道。**

## 二、UI 页面参照 AionUi（React/TS 工作台）

> 出处：AionUi 镜像 `packages/desktop/src/renderer/`（iOfficeAI/AionUi 3.2 万★ Electron/TS Cowork 工作台）。以下把 AionUi 的布局与面板**按积木铁律**（一个组件=一种作用，UI 只订阅事件不改状态、不直连 DB）映射到我们工作台。

### 1. 全局布局（参照 AionUi `components/layout/Layout.tsx` + `Sider/`）
```
┌──────────┬────────────────────────────────────────────────┐
│  Sider   │  Titlebar（品牌/返回/设置判断）                │
│  导航     ├──────────────────────────┬─────────────────────┤
│  折叠栏   │  Chat 会话区             │  Preview 预览区      │
│  (图标)   │  ┌────────────────┐    │  ┌──────────────┐   │
│  会话列表  │  │ Explorer 文件树 │    │  │ PreviewTabs  │   │
│  定时任务  │  │ Chat 消息流    │    │  │ BrowserTab   │   │
│  设置     │  │ SendBox/命令   │    │  │ CodeEditor/  │   │
│          │  └────────────────┘    │  │ DiffViewer…  │   │
└──────────┴──────────────────────────┴─────────────────────┘
```
- **Sider**：可折叠图标栏（会话/文件/定时任务/设置，参照 `SiderItem`/`SiderAssistantEntry`/`SiderScheduledEntry`）
- **Chat 区**：消息流 + 底部 SendBox（参照 `SendBox/`、`SlashCommandMenu`、`CommandQueuePanel`）
- **Preview 区**：宿主级持久化预览面板（参照 Layout `previewRegionActive` 设计——不随会话 remount，结构持久）

### 2. 消息项组件（一组件=一种作用，参照 `pages/conversation/Messages/`）
| 场景 | 参照组件 | 映射到我们 | 积木作用 |
|---|---|---|---|
| 思考过程 | `MessageThinking.tsx` | 模型 thinking 折叠 | 纯展示 thinking |
| 计划 | `MessagePlan.tsx` + `MessageAnchorRail.tsx` | 任务 Plan/DAG 可视化 | 展示 plan |
| 工具调用 | `MessageToolCall.tsx` / `ToolCallBlock` | TaskEvent `tool.called/result` | 渲染一次工具调用 |
| 工具组汇总 | `MessageToolGroup.tsx / MessageToolGroupSummary` | 工具执行序列 | 归组展示 |
| 审批 | `MessagePermission/PermissionRequestPanel.tsx` + `MessageQuestion.tsx` | Approval 审批窗 | 渲染 approval.required，等用户意图 |
| 终端输出 | ACP `MessageAcpTerminalOutput.tsx` + `MessageAcpToolCall.tsx` | 受限终端工具输出 | 展示终端 stdout/stderr |
| 技能建议 | `MessageSkillSuggest.tsx` / `SkillSuggestCard` | Skill 推荐卡片 | 展示可复用 Skill |
| 产物 | `artifacts.tsx` + `MessageFileChanges.tsx` | Artifact + diff | 产物/文件变更展示 |

### 3. Preview 多视图（参照 `pages/conversation/Preview/`）
- **预览面板**：`PreviewPanel/`（工具栏 `PreviewToolbar` + 多 Tab `PreviewTabs`）
- **viewers**（一 viewer=一种作用）：`PDFViewer / PptViewer / ExcelViewer / MarkdownViewer / HTMLViewer / ImageViewer / URLViewer / OfficeDocViewer`
- **editors**（可继续编辑、可替换素材）：`MarkdownEditor / CodeEditor / HTMLEditor` ← 对应"产物可编辑率"指标
- **浏览器**：`browser/BrowserViewer` + `BrowserTabLayer`；安全=单 active tab（承接 AionUi「只暴露单 webview target 的 CDP bridge、OS 端口、token gating」）
- **diff**：`viewers/DiffViewer.tsx` ← 承接"差异可回滚"

### 4. 文件/源码面板（参照 `pages/conversation/explorer/`）
- `ExplorerPanel` 文件树；`SearchPanel` 搜索；`FileTypeIcon` 文件类型图标
- `SourceControl/ScmPanel` + `ScmChangesView + ScmResourceRow`（git 变更/增减文件视图）← 承接"编码任务修改可审查"

### 5. 任务/调度页（参照 `pages/cron/ScheduledTasksPage/`）
- `ScheduledTasksPage/index.tsx` + `CreateTaskDialog` + `CronStatusTag` + `TaskDetailPage`（定时任务清单/创建弹窗/状态标签/详情）← 对应 Schedule 领域对象

### 6. 首屏引导（参照 `pages/guid/`）
- `GuidPage` + `GuidInputCard` + `GuidModelSelector` + `QuickActionButtons` + `AssistantSelectionArea` + `SkillsMarketBanner`（一句话提目标 + 快捷任务 + 助手选择）← 承接"Outcome→Plan"第一步

### 7. Agent/运行时选择（参照 `components/agent/`）
- `AgentBadge / AcpModelSelector / AgentModeSelector / RuntimeSelectorPill / ContextUsageIndicator`（当前 Agent 徽标、模型选择、运行模式、上下文用量）

## 三、UI 层的积木铁律（React 侧同样适用）
1. **组件=一种作用**：`MessageThinking` 只渲染思考、`PDFViewer` 只渲染 PDF、`PermissionRequestPanel` 只渲染审批——组件不直连 provider/DB。
2. **UI 只订阅事件 + 发意图，不改状态**：消息来自 `TaskEvent`（C6 事件订阅），SendBox 只 `emit('task.create')`。
3. **Preview 宿主级持久**：不随会话 remount（AionUi 教训），减少无谓重挂载与状态丢失。
4. **浏览器=单 active tab + OS 端口 + token**（AionUi 安全修正），不是整个 Chromium 进程。
5. **变量命名沿用英文**（新代码），组件目录按功能单分类（`chat/ preview/ explorer/ sourcecontrol/ cron/`）。

## 四、下一步：把 UI 落成可运行骨架
1. 建 `apps/workbench/src/components/Sider.tsx`（可折叠导航，一文件一作用）
2. 建 `apps/workbench/src/pages/conversation/Messages/MessageThinking.tsx`（订阅 thinking 事件）
3. 建 `apps/workbench/src/pages/conversation/Preview/PreviewPanel.tsx`（多 Tab + viewers 路由）
4. 建 `apps/workbench/src/pages/conversation/Preview/browser/BrowserViewer.tsx`（单 active tab）
5. 建 `apps/workbench/src/App.tsx`（Layout：Sider + Chat + Preview 三栏，参照 AionUi Layout.tsx）

—— 溯源真实、UI 参照 AionUi、全部遵守积木铁律；本文件与《拼接代码总纲》配套可直接开工。 ——
