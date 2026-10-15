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
| `crates/process-supervisor/src/command_policy.rs` | `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-*.ts`（`bash-command-parser.ts`、`bash-readonly-policy-types/-argv/-argv-flags/-argv-direct/-argv-git/-argv-io/-commands/-flags-*/-git-subcommands-*/-callbacks/-git-callbacks/-multiword-*`） | 由 TypeScript 改写为 Rust：保留逐命令/逐标志的只读判定语义与全部只读数据表（含 git 子命令策略与 `find`/`tree` 写入选项）。去掉上游基于 `unbash` 的 AST 解析——b07 禁止命令拼接、管道与重定向，argv 由引号感知的拆分得到，不存在 `AndOr`/`Pipeline` 节点。新增 b07 语义：`Routine` 档（允许且无需确认的常规动作）与「对外发布 / 丢弃未提交工作 / 改写历史」子命令清单，使移植前子串匹配的两类错误一并消失——假阳性（`npm run clean` 被当成 `git clean`）与假阴性（`find . -delete`、`find . -exec` 未被识别为写入） |
| `packages/agent-runtime/src/network/egress-policy.ts` | `apps/zcode-cli/packages/contracts/src/network/public-egress-ip.ts`、`apps/zcode-cli/packages/core/src/tool/handlers/webfetch-egress-guard.ts` | 合并上游两份文件为单一判定入口；去掉 `ipaddr.js` 依赖，改用 `node:net` 的 `BlockList`；把 IPv4-mapped（`::ffff:0:0/96`）与 NAT64/DNS64 well-known 前缀（`64:ff9b::/96`）承载的私网地址还原写成显式等价子网，而不是逐字节拆包 |
| `packages/agent-runtime/src/modules/audited-scheduler/control-plane.ts`（递归防护部分） | `apps/zcode-cli/packages/core/src/tool/handlers/cron.ts`、`apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts` 的 handler 级 turn 拒绝 | 由 TS 工具 handler 改写为 b07 调度控制面方法上的可选「本轮事实」参数（`ScheduleTurnFacts`）：automation 轮拒写调度定义（`registerCandidate`/`review`/`enable`/`disable`/`revoke`），闲时轮拒派生新 run（`planDueRun`）。沿用「两条 deny 边界判据不同」的上游语义（闲时边界刻意不检查 `automationTurn`，故 cron 轮放行派生）；拒绝以稳定 code（`AUTOMATION_TURN_SCHEDULE_WRITE_DENIED`/`OFF_PEAK_TURN_DERIVATION_DENIED`）与 `recoverable`/`retryable: false` 外显，判据只取调用方传入的本轮事实 |
| `packages/agent-runtime/src/subagent-prompts.ts` | `apps/zcode-cli/packages/core/src/subagent/explore.ts`、`apps/zcode-cli/packages/core/src/subagent/general-purpose.ts` | 提示词正文保持上游英文，文件头/注释本地化；去掉 `EnvInfo` 依赖与 legacy `buildExploreSystemPrompt` 包装 |
| `packages/agent-runtime/src/subagent-explore-tools.ts` | `apps/zcode-cli/packages/core/src/subagent/explore-tools.ts` | 语义不变（白名单 + 两分支 + description 优先级排序）；类型收敛为 `readonly string[]` |
| `packages/agent-runtime/src/subagent-tool-policy.ts` | `apps/zcode-cli/packages/core/src/subagent/tool-policy.ts`、`apps/zcode-cli/packages/core/src/tool/tool-visibility.ts` | 合并上游两份文件：内联 `filterDisallowedToolNames` 的别名归一与 `Tool(pattern)` 规则解析，去掉 `@zcode/contracts` 依赖；新增 `isSubagentChildToolDisallowed` |
| `packages/agent-runtime/src/subagent-profile.ts` | `apps/zcode-cli/packages/core/src/subagent/profile.ts`、`packages/shared/src/subagent-profile-parser.ts`、`packages/shared/src/subagent-profile-frontmatter.ts` | 类型改名 `AgentProfile`→`SubagentProfile`（避免与 b07 既有 profile 概念冲突）；去 zod 与 `ModelSelection`，手写宽松 frontmatter 子集；内置名用 `explore`（小写，对齐 b07 只读子任务角色）；b07 差异：内置 explore 的 `systemPrompt` 由 `buildExploreSystemPrompt` 直接固化（上游留空、由 runner 运行时构造） |
| `packages/agent-runtime/src/subagent-tools.ts` | `apps/zcode-cli/packages/core/src/subagent/runner.ts`（Agent 事件命名与结果预算思路） | 只借「Agent/Task 委派工具」的命名与结果预算语义，不移植 2145 行 runner；工具元数据改为复用 `@awo/protocol` 的 `ToolDescriptor`，预算走 `resultBudgetChars` |
| `packages/agent-runtime/src/subagent-message-steering.ts` | `apps/zcode-cli/packages/core/src/subagent/message-steering.ts`、`apps/zcode-cli/packages/core/src/subagent/coordinator-response.ts` | 保留 summary+空行的协调者消息格式与消息幂等语义；上游的 turn steer 重试（`no_active_turn` 轮询）在 b07 无对应运行时，改写为可注入的双向队列路由 |
| `packages/agent-runtime/src/subagent-profile-store.ts` | 方案原文「profile 存储接 memory-ledger」+ `apps/zcode-cli/packages/core/src/subagent/persistent-memory.ts` 的 profile 落盘思路 | 本仓库新写：用户/项目 profile 以 `durable_fact` 记忆落账，复用 `MemoryLedger` 的 append-only 修订与 supersede 链；内置 profile 拒绝落账 |
| `packages/agent-runtime/src/plugin-marketplace-types.ts` | `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts`、`apps/zcode-cli/packages/contracts/src/plugins/index.ts`（市场类型与 `PluginDiagnosticCode` 闭集） | 收敛为 b07 会真实落地的分支：去掉 official / zip / 依赖闭包相关字段；`PluginValidationDiagnostic` 沿用上游同形（code/message/path/pluginId/severity）；新增 b07 桥接诊断码 `plugin_app_declaration_missing`、`plugin_app_registration_failed` 与 `PluginMcpAppDeclaration` |
| `packages/agent-runtime/src/plugin-marketplace.ts` | `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` | 由 TS adapter 改写为领域服务：保留 `parseMarketplaceSourceInput`、市场清单加载、`findPluginManifestPath`（`.zcode-plugin` → `.claude-plugin` → `.codex-plugin`）、`readPluginManifestFromRoot`、`validatePluginRoot`、`toManifestDisplayMetadata` 语义，市场清单文件优先 `.claude-plugin/marketplace.json`、回退根目录 `marketplace.json`；去掉远端 git/zip 下载、official marketplace CDN、图标增强与依赖闭包解析，来源加载改为可注入的 `MarketplaceSourceResolver`（默认只实现本地目录与文件）；新增 b07 语义——插件经 plugin.json 的 `mcpApp` 字段桥接，`install` 落 `McpAppRegistry.register`，`enable` 复用注册表 enable |
| `packages/agent-runtime/src/plugin-marketplace-store.ts` | 上游 `known_marketplaces.json` / `installed_plugins.json` 的落盘思路 | 本仓库新写：内存 + SQLite 双实现（按 id 覆盖式快照、save 在事务内整表替换），与同包 `mcp-registry` / `extension-registry` 的 store 写法对齐；不移植上游的原子目录激活与事务代际（`cacheTransactionId`）机制 |
| `packages/agent-runtime/src/plugin-marketplace-cli.ts` | `apps/zcode-cli/packages/cli/src/plugins-marketplace-command.ts`、`plugins-command.ts`、`plugins-command-format.ts` | 合并上游 marketplace 与 plugins 两条命令线为 `add` / `install` / `enable` / `list` 单入口，四个子命令统一 `--json`；argv 解析与 stdout/stderr 全部注入以便单测；`--json` 输出沿用上游扁平对象形态（marketplace / plugin / app / diagnostics），去掉上游 Human 表格、`--verbose` 与 warnings 分渠道细节 |
| `tools/plugin-marketplace-cli.ts` | `apps/zcode-cli/packages/cli/src/main.ts` 的命令注册薄壳思路 | 本仓库新写的极薄 shim：把真实 argv / stdout / stderr 接到可单测的 `runPluginMarketplaceCli`，并装配 SQLite 默认依赖；不移植上游的全局选项、locale 与 bootstrap 装载 |

### 语义借用（非源码移植）

`apps/workbench/src/runtime/zcode/zcode-agent-adapter.ts` 与 `zcode-protocol-client.ts` 只借用上游**协议事实**，未移植实现代码：CAS 失败错误码 `-32009` 与 `data.actualRevision`（上游 `assertExpectedRevision`）、`session/subscribe` 的 `afterSeq`/`includeSnapshot` 续播与快照形态、`session/send` 的 `inputId`/`expectedRevision` 参数。上游为 Apache-2.0，此处按其条款声明出处。

移植文件头部均带有出处注释。对上游代码的修改遵循 Apache-2.0 的再分发条款（保留许可与版权声明、标注修改）。
