# 更改基线 BASELINE（v0.1.0 — 首个冲刺）

<!-- file-id: acct2-20260819-ai-work-os-baseline ; 作者: 账号2 ; 日期: 2026-08-19 -->

> 本文件记录**基线起点**：仓库首个可运行状态由哪些内容构成、在什么环境下验证通过。
> 后续每次结构变更/接口变更都应在 `CHANGELOG.md` 记录；基线本身只描述"首个可运行状态"。

## 基线内容（v0.1.0）

| 模块 | 作用 | 验证 |
|---|---|---|
| `packages/protocol` | 协议唯一事实源：`TaskEvent` 类型 + JSON Schema | ✅ tsc 纳入编译 |
| `crates/process-supervisor` | Rust 子进程监督（拉起/随父自退/退出回收） | ✅ `cargo check` 零警告 |
| `sidecars/document-worker` | Python FastAPI + token 鉴权 + 纯文档处理 | ✅ 端到端 401/200 通过 |
| `packages/provider-sdk` | ModelDriver 端口 + OpenAI SSE adapter + Router | ✅ `tsc` 零错误 |
| `packages/agent-runtime` | DAG 执行器（环检测/幂等键/事件发射） | ✅ `tsc` 零错误 |
| `apps/workbench` | React 三栏工作台（Sider+事件流+Preview+单tab浏览器） | ✅ `tsc` 零错误 |
| `docs/` | 5 份架构/规范/溯源文档 | — |

## 基线验证环境（本机）

- OS: Windows（Git Bash）
- Rust: cargo/rustc 1.97.1
- Node: v24.18.0，npm 11.16.0（**无 pnpm** → 采用 npm workspaces）
- Python: 3.14.4（sidecar 使用项目内 `.venv`，fastapi 0.141.1）

## 基线验证命令（全部通过）

```bash
cargo check -p process-supervisor
python -m py_compile processor.py app.py   # 语法
python -c "from processor import process_document; ..."  # 纯模块单测
# token 端到端：无 token→401，错 token→401，正 token→200
npx tsc -p tsconfig.base.json              # TS packages
npx tsc --noEmit -p tsconfig.json          # workbench UI
```

## 边界约定（基线即生效）

- 三语言职责：Rust 控制面 / TS 编排 / Python 重计算，不跨界
- 通信只走渠道（C1–C6），UI 只订阅事件+发意图，不直连 DB/provider
- 每个文件/包一种作用；替换实现只换 adapter 不换 port
