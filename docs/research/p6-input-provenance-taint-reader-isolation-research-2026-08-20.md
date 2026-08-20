# P6.0：输入 Provenance、Taint 与 Reader Agent 隔离研究

**作者：Manus AI**

**日期：2026-08-20**

## 研究结论

OpenClaw 将网页、邮件、附件、文档、粘贴日志和工具结果明确视为潜在不可信内容，并建议将高风险内容路由给工具受限的 reader agent，再将受控摘要移交主 Agent。[1] 这与 AI Work OS 的本地单操作者模型兼容，但不能把任务 ID、session ID、管理员租约、浏览器请求或模型摘要误作认证或授权凭据。

P6.0 采用四档固定 trust class：`operator-authored`、`workspace-controlled`、`external-untrusted` 与 `derived-untrusted`。任何外部 URL、上传文件、检索内容、provider/tool 输出及其变换摘要，默认属于后两档；系统不因文本中声称“可信”或“已批准”而降低 taint。

| 契约 | P6.0 的安全语义 |
|---|---|
| `InputProvenanceV1` | 仅保存 input ID、trust class、source kind、SHA-256 digest 与可选 label；不保存原文、URL、路径、凭据或任意 instruction。 |
| 任务 ingress | HTTP 只可声明受限的 provenance 摘要；所有未声明字段拒绝。旧客户端缺省为 `operator-authored`，维持现有受控本地输入行为。 |
| 运行时持久化 | provenance summary 必须进入 submit idempotency 指纹、`RecoverableTaskRequest`、SQLite 快照与恢复一致性检查。 |
| Taint policy | `external-untrusted` 与 `derived-untrusted` 对 `filesystem.write`、`network.fetch`、`shell.execute`、`browser.control` 施加 deny；`document.parse`、`model.chat` 与 `filesystem.read` 保持既有 Profile/Authority 上限。 |
| Declassification | P6.0 不提供隐式或浏览器 HTTP 的 declassification。未来只能由可信桌面宿主签发一张 task/run/digest 绑定、短时、append-only 的 approval metadata；它最多把 taint gate 改为 `require_approval`，不能改为 allow，也不能覆盖既有 deny、预算、sandbox 或资源限制。 |
| Reader profile | `reader` 是独立 Agent Profile，能力上限仅含 `document.parse`、`model.chat` 和 `filesystem.read`，可处理外部内容但无法写入、取网、Shell 或控制浏览器。 |
| 审计 | 新增 `input.provenance.recorded` 事件只记录 input ID、trust class、source kind、digest 与条目数；trajectory 仅投影脱敏 metadata，永不重放副作用。 |

## 实现顺序

首先在 Protocol 定义 trust/source 枚举、`InputProvenanceV1`、任务提交 decoder 和事件 schema。随后在 Agent Runtime 实现 `TaintAwareCapabilityPolicy`，它包裹既有 `AuthorityCapabilityPolicy` 的结果，只能收紧决议。第三步把 summary 写入恢复快照和 Gateway idempotency 指纹，最后由 Workbench 在只读任务状态中展示信任等级与隔离说明。

P6.0 不引入 URL fetch、文件上传、邮件连接、真实 agent-to-agent handoff 或自动化 declassification；这些输入面将留给后续专门的受控 ingress 里程碑。这样可以先使协议、恢复和 policy 语义稳定，而不扩大攻击面。

## References

[1]: https://docs.openclaw.ai/gateway/security "OpenClaw Gateway Security"
