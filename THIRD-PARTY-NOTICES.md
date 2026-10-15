# Third-Party Notices

本仓库直接移植（vendored）了以下第三方源码。除下列声明外，其余代码为本仓库原创。

## ZCode（Apache License 2.0）

- 来源仓库：https://github.com/bear20252026/ZCode （`main` 分支）
- 许可证：Apache License 2.0，**全文副本见 [`LICENSES/ZCode-Apache-2.0.txt`](LICENSES/ZCode-Apache-2.0.txt)**（再分发移植源码时必须连同本文件与许可副本一起提供）
- 移植文件与上游出处：

| 本仓库文件 | 上游出处 | 相对上游的差异 |
| --- | --- | --- |
| `packages/protocol/src/code-editing/patch-parser.ts` | `apps/zcode-cli/packages/core/src/tool/patch-parser.ts` | 仅引号风格与注释本地化，解析语义不变 |
| `packages/protocol/src/code-editing/patch-apply.ts` | `apps/zcode-cli/packages/core/src/tool/patch-apply.ts` | 新增：CRLF 与末尾换行保留、匹配严格度（strict）外显 |
| `packages/protocol/src/code-editing/patch-policy.ts`（部分逻辑） | 上游 apply_patch 工具的路径处理思路 | 本仓库新写的第一期策略层：仅更新已存在文件、路径逃逸拒绝、重复目标拒绝 |
| `packages/protocol/src/session-protocol/session-log-sync.ts` | `docs/v4-refactor/04-sync-and-recovery.md`（收敛规则） | 按规则重写为对载荷泛型的独立实现：条目/快照分型、补齐基准锚定（`bootstrap`）、快照水位以下缓存作废；新增 b07 语义——订阅 ACK 的 `eventSeq` 作为订阅点水位可定基准（上游明确「ACK 不建立基准」） |
| `packages/protocol/src/session-protocol/session-command.ts` | `packages/shared/src/zcode-protocol-v4/command.ts`（命令信封与裁决闭集） | 重写为 TS 接口 + 构造/校验函数：状态与拒绝码沿用上游闭集，字段名对齐 b07 调用方；`withCommandBase` 改为未指定即沿用原基准（重试不得丢掉 CAS） |
| `packages/protocol/src/session-protocol/session-command-ledger.ts` | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`（幂等键控与有界裁决表纪律） | 上游是**接收方**（服务端）表，本文件把它落到**调用方**一侧：在途登记 + 已裁决 LRU、载荷指纹串号识破、stale 同基准重放识破 |
| `packages/protocol/src/session-protocol/session-limits.ts` | 上游同类常量的量级参考 | 本仓库新写的约束值（补齐轮数/退避/缓冲上限/幂等表容量） |

### 语义借用（非源码移植）

`apps/workbench/src/runtime/zcode/zcode-agent-adapter.ts` 与 `zcode-protocol-client.ts` 只借用上游**协议事实**，未移植实现代码：CAS 失败错误码 `-32009` 与 `data.actualRevision`（上游 `assertExpectedRevision`）、`session/subscribe` 的 `afterSeq`/`includeSnapshot` 续播与快照形态、`session/send` 的 `inputId`/`expectedRevision` 参数。上游为 Apache-2.0，此处按其条款声明出处。

移植文件头部均带有出处注释。对上游代码的修改遵循 Apache-2.0 的再分发条款（保留许可与版权声明、标注修改）。
