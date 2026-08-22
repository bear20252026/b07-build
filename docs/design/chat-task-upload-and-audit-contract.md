# 聊天任务上传与全仓功能审计契约

**状态：** 本轮实施契约。本文以当前 `b753f67` 之后的源码审计为依据；“已实现”必须由测试或运行证据支持。

## 审计结论与证据边界

| 编号 | 结论 | 严重性 | 证据分类 | 处置 |
| --- | --- | --- | --- | --- |
| UPL-01 | 首页聊天附件此前仅保存脱敏描述符；其 `File` 字节没有进入 Gateway、任务文件账本或任务输入。 | P1 | source-confirmed | 本轮必须改为实际任务范围上传。 |
| UPL-02 | 任务提交 DTO 已支持 `upload` 来源的不可信摘要，但浏览器可提交摘要，Gateway 没有为真实文件重新计算摘要。 | P1 | source-confirmed | 摘要只由 Gateway 对接收到的字节计算。 |
| UPL-03 | `TaskFileWorkspace` 只接受由已登记 tool artifact 产生的受限文本文件，无法承载用户上传的二进制或文档。 | P1 | source-confirmed | 增加受限的外部上传记录；不可执行、不可自动解压。 |
| UPL-04 | 任务 DAG 的 `model.chat` 与 `filesystem.read` 当前为受控演示 runner；任务提交并不会自动把上传文件或目标文本发送给第三方 Provider。 | P0（功能完整性） | source-confirmed | 上传存储与任务范围读取先落地；实际“任务模型调度”必须作为下一独立里程碑接入显式已激活 Provider 和审批/数据边界。 |
| AUD-01 | 前端主工作面、Gateway 路由、SQLite 元数据账本、Tauri 壳、Rust 工具及 Sidecar 均有自动质量门；但 Windows 真机 WebView2、文件选择和桌面常驻行为仍需运行证据。 | P2 | requires-runtime-evidence | 保留 Windows 真机验收门。 |

## 上传协议与存储边界

聊天输入的每个文件只在用户按下“开始任务”后随同该次提交送到本机 Gateway。Gateway 必须校验总数、文件名、字节总量和 base64 形状；自行计算 SHA-256；创建 `external-untrusted / upload` provenance；并把内容写入 `taskId/runId` 专属目录。SQLite、事件、轨迹和返回 DTO 只能保存脱敏元数据、逻辑名称、长度和摘要，不能保存绝对路径、原始字节、API key 或文档全文。

上传不能触发解压、宏、脚本、终端、自动识别、网络请求或 Provider 调用。压缩包、PDF、Office 和未知二进制可作为受控附件留在任务区，但默认只允许元数据投影。文本与代码已由既有 `filesystem.read` 受控步骤建立最多 64 KiB 的瞬时 task/run 投影；该投影不写入 SQLite、事件或 HTTP DTO，且当前不会自动转发到 Provider。读取仍受到不可信输入 taint policy 和权限模式约束。

## 不可混淆的用户状态

| 用户状态 | 含义 |
| --- | --- |
| 待处理附件 | 浏览器本地已选择，尚未提交。 |
| 正在上传到本机任务区 | 用户已点击开始任务，字节正在发送给 loopback Gateway。 |
| 已登记为不可信任务附件 | Gateway 已验证并写入 task/run 专属目录，AI 工具可在受控读取步骤中发现。 |
| 未发送至第三方模型 | 任务 Provider 调度尚未启用或尚未经过显式确认。 |

> “上传到软件”与“发送到第三方 AI”是两个不同副作用。前者由本机 Gateway 的任务文件边界实现；后者必须由已激活 Provider、可见数据边界与明确提交动作单独控制。

## 验收要求

实现后至少验证：超过数量/大小的请求拒绝、坏 base64 拒绝、路径穿越名称拒绝、凭据样式文本拒绝、上传摘要由 Gateway 计算、任务快照记录 upload provenance、任务文件列表可见而不泄露路径、文本投影只存在于 task/run 受控读取步骤、二进制没有预览/执行、幂等重放不重复写入，以及任务提交失败时不宣称上传成功。

## References

[1]: https://owasp.org/www-project-application-security-verification-standard/ "OWASP ASVS"
[2]: https://csrc.nist.gov/projects/ssdf "NIST Secure Software Development Framework"

本契约采用输入默认不可信、服务端校验和最小副作用原则，符合 OWASP ASVS 与 NIST SSDF 的通用安全开发方向。[1] [2]
