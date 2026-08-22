# 聊天上传与仓库功能审计报告

**审计日期：** 2026-08-22  
**审计范围：** `bear20252026/b07-build` 的聊天附件、任务 HTTP 契约、Gateway、任务文件账本、受控运行时、Workbench 与桌面质量门。  
**对应提交：** `75195a0`（`feat(tasks): bind chat uploads to task inputs`）。

## 执行摘要

本轮已将首页聊天框的附件能力从“仅保存名称、大小、类别的前端描述符”升级为**用户点击开始任务时写入本机 Gateway 管理的 task/run 专属文件区**。上传字节由 Gateway 重新计算 SHA-256，并由服务端生成 `external-untrusted / upload` provenance；前端不能伪造可信来源或上传摘要。任务文件元数据、事件、轨迹和 HTTP DTO 不保存绝对路径、原始字节、API key 或文件全文。

文本和代码上传现在可在 `filesystem.read` 的受控执行步骤中生成最多 **64 KiB** 的瞬时 task/run 投影。压缩包、PDF、Office 及未知二进制只作为静态附件登记，默认不可自动预览、解析、解压、执行或转发。该边界避免把用户上传内容拼入终端命令或自动发送到第三方。

> **重要的真实边界：** 当前任务 DAG 的 `model.chat` 仍是受控演示 runner。尽管项目已存在独立的、只接受 active Provider Profile 的 Provider 推理服务，任务运行时尚未把“目标文本 + 受控附件投影”发送给该服务。因此，本轮完成的是“真实上传到软件 + 任务范围受控读取”；并**没有**把远程 Provider 的实际模型消费误报为已完成。将 Provider 选择、可见数据出境确认、模型结果回写和用量审计绑定至同一任务提交，是下一项 **P0**。

## 已修复的功能链路

| 层级 | 已实现行为 | 证据 |
| --- | --- | --- |
| Workbench 附件选择 | 点击/拖放后仅在页面内存保留 `File` 与脱敏描述符；最多 8 项，重复名称与大小会被过滤。 | `composer-attachments.test.ts` 通过。 |
| 发送行为 | 只有用户点击开始任务时才读取 `File` 字节、编码为受限 base64 并提交本机 loopback Gateway。成功创建任务后清空候选；失败时保留以供重试。 | `use-task-execution.ts`、`task-client.test.ts` 通过。 |
| HTTP 契约 | `uploads` 是可选、严格 schema 的 v1 字段；单文件 256 KiB，最多 8 个；旧客户端省略该字段保持兼容。 | `http-contracts.test.ts` 通过。 |
| Gateway 入站校验 | 任务路由限制 body 为 3 MiB；检查严格 base64、安全文件名、重复 ID、大小，并由 Gateway 计算 SHA-256。 | `task-http-contract.test.ts` 通过。 |
| 不可信标记 | 浏览器上传来源由 Gateway 生成 `external-untrusted/upload` provenance；浏览器自称 upload provenance 会收到 400。 | Gateway 端到端测试通过。 |
| 受控存储 | 原始字节保存在 task/run 范围的文件根；SQLite 和 DTO 只持久化逻辑路径、摘要、大小、类型、来源和安全标记。 | `task-file-workspace.test.ts`、SQLite 重开测试通过。 |
| 二进制策略 | 未知扩展、压缩包等会标记为 `application/octet-stream`；预览与差异接口显式拒绝，不解压也不执行。 | Gateway 和任务文件单元测试通过。 |
| 文本投影 | 仅 `user-upload` 的文本记录可进入最多 64 KiB 的瞬时投影；投影跳过二进制，且不进入事件、DTO 或 Provider。 | `task-file-workspace.test.ts` 通过。 |
| 凭据防护 | `sk-…`、`ghp_…`、`Authorization: Bearer …` 样式内容在创建任务、写入账本之前拒绝。 | Gateway 端到端测试通过。 |

## 全仓审计发现与优先级

| 优先级 | 发现 | 当前结论与建议 |
| --- | --- | --- |
| **P0** | 远程模型任务调度未连接受控任务上下文。 | 不能声称“聊天发送后远程 AI 已阅读文件”。下一里程碑应在任务提交中要求显式已激活 `providerId` 与数据出境确认，传递经过 64 KiB 预算的投影，向任务事件只记录摘要与模型元数据。 |
| **P1** | 本轮未实现独立的预上传暂存端点。 | 当前采用“发送时原子提交上传”设计，避免选择文件即产生磁盘副作用；适合安全与简单状态。若未来需要大文件进度、断点续传或发送前本地持久化，应新增具备 TTL、取消和原子 claim 的 `/api/task-inputs` staging 服务，而不能复用生成产物 API。 |
| **P1** | Office/PDF/压缩文件可保存但未内容提取。 | 这是有意的安全默认。后续若需阅读，应为每种格式引入独立、隔离、限资源的 extractor，并对“提取后将发送给 Provider”要求明确确认。 |
| **P2** | Windows 真机 WebView2 与文件选择行为仍需发布候选验收。 | Linux/Tauri 编译与合同测试已通过；仍建议在目标 Windows 机器上完成选择 Markdown、提交、查看任务文件、断网和 Provider 未配置场景的人工验收。 |
| **P2** | Workbench 生产 bundle 接近 CSS 预算。 | 当前 CSS 为 `148,475 / 150,000` 字节。后续页面工作应优先删除或复用规则，不应继续无约束追加全局样式。 |

## 验证结果

| 验证项 | 结果 |
| --- | --- |
| 架构依赖与边界检查 | 通过；307 模块、785 依赖，无违规。 |
| TypeScript 严格类型检查 | 通过。 |
| 全仓 Node 测试 | **292/292 通过**。 |
| 定向聊天上传回归 | **40/40 通过**。 |
| Workbench 生产构建与性能预算 | 通过；JavaScript `461,015 / 500,000`，CSS `148,475 / 150,000`。 |
| 生产依赖安全审计 | `0 vulnerabilities`（`npm audit --omit=dev --audit-level=high`）。 |
| Rust `process-supervisor` | `fmt`、`check`、11 个测试与 Clippy 均通过。 |
| Tauri 桌面壳 | Linux 环境下 `fmt`、`check`、测试与 Clippy 均通过；桌面合同测试 7/7 通过。 |
| Gateway sidecar | 构建成功，仅用于检查的 bundle 已生成后未纳入提交。 |

## 安全与产品行为说明

本轮遵循“默认不可信、服务端重新验证、最小副作用”的上传处理方式。文件不会在选择时自动上传；不会自动发给远程模型；不会解压、执行、运行宏、拼接至 shell 命令或扫描任意目录。用户能够在任务页面看到 task/run 专属的附件元数据和允许的文本预览；二进制保持可审查的静态状态。

该设计与 OWASP ASVS 对输入验证、数据最小化和服务端边界验证的通用方向一致，也符合 NIST SSDF 的安全设计与验证原则。[1] [2]

## References

[1]: https://owasp.org/www-project-application-security-verification-standard/ "OWASP Application Security Verification Standard"
[2]: https://csrc.nist.gov/projects/ssdf "NIST Secure Software Development Framework"
