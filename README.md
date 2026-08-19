# AI Work OS — 积木式最小可运行骨架（首个冲刺）

<!-- file-id: acct2-20260819-ai-work-os ; 作者: 账号2 ; 日期: 2026-08-19 -->

由账号2生成。首个冲刺已按《积木架构铁律》《拼接代码总纲》拼出三语言最小可运行工程，全部通过验证。

## 已落地模块（每包/每 crate/每文件=一种作用）

| 模块 | 作用 | 验证状态 |
|---|---|---|
| `packages/protocol` | 协议唯一事实源：v1.0 `TaskEvent` + JSON Schema + 运行时契约校验（含 Profile/压缩/预算事件） | ✅ 类型检查 + 契约测试 |
| `crates/process-supervisor` | Rust 子进程监督：拉起/随父自退/退出回收（OpenWorker+AgentForge 式） | ✅ `cargo check` 零警告 |
| `sidecars/document-worker` | Python FastAPI + token 鉴权 + 纯文档处理（OpenWorker 式） | ✅ 端到端 401/200 通过 |
| `packages/provider-sdk` | ModelDriver 端口 + OpenAI adapter(SSE) + Router（AgentForge/cc-switch 式） | ✅ `tsc` 零错误 |
| `packages/agent-runtime` | 可恢复本地任务工厂 + 并发 DAG + 调度统计 + Agent Profile + 默认拒绝策略 + 审批门控 + 执行/上下文预算 | ✅ 类型检查 + 29 项运行时测试 |
| `apps/workbench` | AionUi 对齐三栏工作台：持久 Sider + 任务事件流 + 目标输入 + 常驻 Preview | ✅ Vite 构建 + `tsc` 零错误 |

## 验证命令（本机已通过）
```bash
cargo check -p process-supervisor          # Rust ✅
cd sidecars/document-worker && ./.venv/Scripts/python.exe -m py_compile processor.py app.py  # Python ✅
npm run typecheck                           # TS packages + tests ✅
npm test                                    # 事件契约/DAG/Profile/审批/恢复/预算 ✅
npm run benchmark:dag                       # 受控 DAG 并发调度基准 ✅
npm run build --workspace=@awo/workbench                # UI 生产构建 ✅
npm run typecheck --workspace=@awo/workbench            # UI 类型检查 ✅
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
1. 为 `TaskSnapshotStore` 实现 SQLite append-only 适配器，并支持进程重启后的任务恢复
2. Rust `process-supervisor` 消费调度统计、心跳与取消信号，形成高吞吐控制面
3. 工作台接入真实任务提交、审批、上下文用量、运行快照与恢复状态
4. 增加 launch checkpoint / steer / interrupt 语义，明确运行中与未启动节点的取消边界
5. 受控 Hook port（只能拒绝/观察，不能绕过策略与审批）
