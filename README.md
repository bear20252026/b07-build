# AI Work OS — 积木式最小可运行骨架（首个冲刺）

<!-- file-id: acct2-20260819-ai-work-os ; 作者: 账号2 ; 日期: 2026-08-19 -->

由账号2生成。首个冲刺已按《积木架构铁律》《拼接代码总纲》拼出三语言最小可运行工程，全部通过验证。

## 已落地模块（每包/每 crate/每文件=一种作用）

| 模块 | 作用 | 验证状态 |
|---|---|---|
| `packages/protocol` | 协议唯一事实源：`TaskEvent` 类型 + JSON Schema（C3/C6 通道） | ✅（tsc 纳入） |
| `crates/process-supervisor` | Rust 子进程监督：拉起/随父自退/退出回收（OpenWorker+AgentForge 式） | ✅ `cargo check` 零警告 |
| `sidecars/document-worker` | Python FastAPI + token 鉴权 + 纯文档处理（OpenWorker 式） | ✅ 端到端 401/200 通过 |
| `packages/provider-sdk` | ModelDriver 端口 + OpenAI adapter(SSE) + Router（AgentForge/cc-switch 式） | ✅ `tsc` 零错误 |
| `packages/agent-runtime` | DAG 执行器：节点/幂等键/事件发射（dsh+CoreCoder 思路） | ✅ `tsc` 零错误 |
| `apps/workbench` | React 三栏工作台：Sider + 事件流 + Preview + 单 tab 浏览器（参照 AionUi） | ✅ `tsc` 零错误 |

## 验证命令（本机已通过）
```bash
cargo check -p process-supervisor          # Rust ✅
cd sidecars/document-worker && ./.venv/Scripts/python.exe -m py_compile processor.py app.py  # Python ✅
npx tsc -p tsconfig.base.json              # TS packages ✅
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
2. Python retrieval-worker（Embedding/RAG）
3. Rust↔Python 真实拉起接线（`AWO_SIDECAR_TOKEN` 注入）
4. Provider adapter 扩充（anthropic / local）
5. 事件协议契约测试（JSON Schema 校验）
