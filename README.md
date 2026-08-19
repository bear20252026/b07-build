# AI Work OS — 积木式最小可运行骨架（首个冲刺）

<!-- file-id: acct2-20260819-ai-work-os ; 作者: 账号2 ; 日期: 2026-08-19 -->

由账号2生成。首个冲刺已按《积木架构铁律》《拼接代码总纲》拼出三语言最小可运行工程，全部通过验证。

## 已落地模块（每包/每 crate/每文件=一种作用）

| 模块 | 作用 | 验证状态 |
|---|---|---|
| `packages/protocol` | 协议唯一事实源：v1.0 `TaskEvent` + JSON Schema + 运行时契约校验（C3/C6 通道） | ✅ 类型检查 + 契约测试 |
| `crates/process-supervisor` | Rust 子进程监督：拉起/随父自退/退出回收（OpenWorker+AgentForge 式） | ✅ `cargo check` 零警告 |
| `sidecars/document-worker` | Python FastAPI + token 鉴权 + 纯文档处理（OpenWorker 式） | ✅ 端到端 401/200 通过 |
| `packages/provider-sdk` | ModelDriver 端口 + OpenAI adapter(SSE) + Router（AgentForge/cc-switch 式） | ✅ `tsc` 零错误 |
| `packages/agent-runtime` | DAG 执行器 + 默认拒绝能力策略 + 审批门控执行器（只经 ToolRunner port 执行） | ✅ 类型检查 + 执行链测试 |
| `apps/workbench` | React 三栏工作台：Sider + 事件流 + Preview + 单 tab 浏览器（参照 AionUi） | ✅ `tsc` 零错误 |

## 验证命令（本机已通过）
```bash
cargo check -p process-supervisor          # Rust ✅
cd sidecars/document-worker && ./.venv/Scripts/python.exe -m py_compile processor.py app.py  # Python ✅
npm run typecheck                           # TS packages + tests ✅
npm test                                    # 事件契约/DAG/审批门控 ✅
cd apps/workbench && npx tsc --noEmit -p tsconfig.json  # UI ✅
```

## 目录（积木式，单职责）
```
packages/protocol        类型+JSON Schema（唯一事实源）
packages/provider-sdk    ModelDriver 端口 + adapters/（每 provider 一文件）+ router
packages/agent-runtime   DAG 执行器（port: ToolRunner 可替换）
crates/process-supervisor Rust 子进程监督（crate=一类作用）
sidecars/document-worker  FastAPI 路由+鉴权（app.py）/ 纯处理（processor.py）
apps/workbench           React 三栏工作台（一组件=一作用）
```

## 下一步冲刺
1. Rust `security-vault` + `proxy-gateway`（cc-switch 式进程内代理）
2. Rust↔Python 真实拉起接线（`AWO_SIDECAR_TOKEN` 注入、健康检查、失败回收）
3. SQLite append-only 事件日志与任务回放
4. Provider adapter 扩充（anthropic / local）
5. 工作台接入真实任务提交、审批和可编辑产物视图
