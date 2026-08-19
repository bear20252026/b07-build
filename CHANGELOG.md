# 更正记录 CHANGELOG

<!-- file-id: acct2-20260819-ai-work-os-changelog ; 作者: 账号2 ; 日期: 2026-08-19 -->

> 格式：`## [日期] 变更摘要` → `### 修正（原因→处置）` / `### 新增` / `### 决策`。
> 每次更正都记录**为什么改**（基线：BASELINE.md v0.1.0）。

## [2026-08-19] v0.2.0 参考资料分离归档 + 产品目标/参考库/框架总纲

### 决策
- **参考资料与主代码分离**：新增 `reference/` 目录存放外部参考 zip，**不参与**任何 npm/cargo workspace 构建；主代码仍只在 `packages/ crates/ sidecars/ apps/`。
- **MiMo-Code 镜像策略**：只取上游最新单提交（`git clone --depth 1 --single-branch`），**不追历史**；推送到自建公开仓 `bear20252026/MiMo-Code`（孤儿根提交规避浅克隆推送拒绝）。
- **Antelope 最小版**：本地暂无源码文件，列入参考清单（REFERENCE.md），待取得后再入 reference/。

### 新增
- `reference/CoreCoder_7篇源码导读原文归档_20260819.zip`（50K，CoreCoder 7 篇导读原文）
- `reference/ClaudeCode_静态补全候选_20260818.zip`（27M，静态补全候选）
- `reference/REFERENCE.md`（参考材料索引 + 使用规则 + 许可证隔离提醒）
- `docs/产品目标参考代码库与整体框架.md`（产品目标/参考代码库含 Claude Code 7 项工程设计基线 + MiMo-Code + CoreCoder + Antelope/整体积木框架/研发优先级）

### 附注
- 参考材料使用遵循上游许可证；写新代码走清洁实现（自己的领域模型/命名/测试），不复制非公开代码。


### 决策
- **pnpm → npm workspaces**：本机未装 pnpm，改用 npm workspaces 串联 `packages/*` 与 `apps/*`，行为等价、零额外安装。
- **Python sidecar 使用项目内 `.venv`**：避免污染全局 Python 3.14.4；fastapi/uvicorn/httpx 仅装在 sidecar 虚拟环境。
- **仓库可见性 = 公开（public）**：用户明确选择，与既有镜像项目公开模式一致。
- **token 命名统一为 `AWO_SIDECAR_TOKEN`**：避免与上游 OpenWorker 的 `COWORKER_API_TOKEN` 混淆（跨项目辨识）。

### 修正
- **`cargo check` 报 "no targets specified"**：`Cargo.toml` 存在但 crate 根缺失（文件命名为 `supervisor.rs` 而非 `lib.rs`）。
  → 处置：新增 `src/lib.rs`（仅 `pub mod supervisor;`，一文件=一作用：crate 根）。
- **`cargo check` 警告 `unused_mut`**：`shutdown()` 中 `let Some(mut child)` 无可变需求。
  → 处置：去掉 `mut`，消除告警；重跑 `cargo check` 确认零警告。
- **Python `ModuleNotFoundError: fastapi`**：全局 Python 未装 fastapi。
  → 处置：`python -m venv .venv` 并安装 fastapi/uvicorn/httpx，端到端测试通过（401/401/200）。

### 新增
- `packages/protocol`：`types.ts`（TaskEvent 7 事件类型）+ `schema/task-event.schema.json`（JSON Schema 唯一事实源）。
- `crates/process-supervisor`：`supervisor.rs`（spawn 注入 env / Windows CREATE_NO_WINDOW / shutdown 回收 / is_alive 健康检查）+ 单元测试。
- `sidecars/document-worker`：`app.py`（FastAPI 路由 + `secrets.compare_digest` 常量时间 token 鉴权 + 127.0.0.1）/ `processor.py`（纯文档处理，无网络无鉴权）/ `requirements.txt`。
- `packages/provider-sdk`：`driver.ts`（ModelDriver 端口）/ `adapters/openai.ts`（fetch+SSE 流式，`[DONE]` 终止）/ `router.ts`（按任务类型选模型）/ `index.ts`。
- `packages/agent-runtime`：`executor.ts`（DAG 执行器：构造期环检测、ready 队列、ToolRunner 端口注入、事件发射）。
- `apps/workbench`：`App.tsx`（三栏布局）/ `Sider.tsx`（可折叠导航）/ `MessageThinking.tsx`（纯展示）/ `PreviewPanel.tsx`（多 Tab 预览）/ `BrowserViewer.tsx`（单 active tab 安全桥）/ `main.tsx`。

### 附注
- 代码/文档均按《积木架构铁律》：一文件一职责、靠渠道通信、替换实现只换 adapter 不换 port。
- UI 组件参照 AionUi（Layout/Sider/MessageThinking/PreviewPanel/BrowserViewer），已核证真实组件命名。
