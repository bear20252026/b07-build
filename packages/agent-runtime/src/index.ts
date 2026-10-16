// 一个文件=一种作用：代理运行时公共导出边界。
export * from './executor.js';
export * from './capability-policy.js';
export * from './permission-chain.js';
export * from './permission-broker.js';
export * from './hook-contract.js';
export * from './hook-registry.js';
export * from './hook-executor.js';
// Hook 信任域：来源判定 + 准入过滤。Hook 是任意代码执行面，无条件执行等于把
// "读了别人的代码"升级成"跑了别人的代码"；本层在过滤之后、执行之前插入信任准入。
export * from './hook-trust-contract.js';
export * from './hook-trust.js';
export * from './infrastructure/sqlite/hook-trust-store.js';
export * from './agent-profile.js';
export * from './controlled-tool-runner.js';
export * from './context-budgeter.js';
export * from './context-assembly.js';
export * from './microcompact.js';
export * from './execution-budget.js';
export * from './recoverable-task-runtime.js';
export * from './infrastructure/sqlite/task-snapshot-store.js';
export * from './infrastructure/sqlite/administrator-lease-store.js';
export * from './infrastructure/sqlite/trusted-desktop-issuer-store.js';
export * from './session-control-plane.js';
export * from './infrastructure/sqlite/session-snapshot-store.js';
export * from './memory-ledger.js';
export * from './infrastructure/sqlite/memory-ledger-store.js';
export * from './task-command-receipts.js';
export * from './read-only-subtasks.js';
// 子代理体系（P1-2）：profile 模型与 markdown 覆盖、只读工具集、工具面剔除、
// Task/Agent 工具预算、父子消息路由、profile 落 memory-ledger。
export * from './subagent-prompts.js';
export * from './subagent-explore-tools.js';
export * from './subagent-tool-policy.js';
export * from './subagent-profile.js';
export * from './subagent-tools.js';
export * from './subagent-message-steering.js';
export * from './subagent-profile-store.js';
export * from './mcp-registry.js';
export * from './mcp-app-registry.js';
export * from './extension-registry.js';
export * from './extension-activation.js';
// 扩展宿主接线（B3）：激活计划 → ExtensionLaunchSpec 的 fail-closed 映射与可注入后端解析器。
export * from './extension-host-launch.js';
export * from './agent-adapter.js';
export * from './audited-scheduler.js';
export * from './task-runtime-service.js';
export * from './run-trajectory.js';
export * from './api-usage-ledger.js';
export * from './browser-session-control.js';
// 出网公网边界：主机名归一化 + IP 字面量公网校验（借 ZCode public egress 语义）。
export * from './network/egress-policy.js';
export * from './run-workspace-ledger.js';
export * from './task-file-workspace.js';
export * from './project-workspace.js';
export * from './infrastructure/sqlite/project-workspace-store.js';
export * from './recovery-bundle.js';
export * from './desktop-bridge.js';
export * from './execution-authority.js';
export * from './taint-policy.js';
export * from './security-posture-audit.js';
export * from './infrastructure/sqlite/security-posture-audit-store.js';
export * from './component-provenance.js';
export * from './component-management.js';
export * from './native-host-authentication.js';
export * from './windows-native-release-evidence.js';
export * from './infrastructure/sqlite/windows-native-release-evidence-store.js';
export * from './infrastructure/sqlite/native-host-authentication-store.js';
export * from './infrastructure/sqlite/component-management-receipt-store.js';
export * from './infrastructure/sqlite/component-provenance-store.js';
export * from './trusted-desktop-issuer.js';
// 插件市场 CLI（P1-4）：市场源解析、已知市场持久化、插件包清单校验（兼容 .claude-plugin/plugin.json）、
// add/install/enable/list 子命令，install 落 McpAppRegistry。
export * from './plugin-marketplace-types.js';
export * from './plugin-marketplace-store.js';
export * from './plugin-marketplace.js';
export * from './plugin-git-source.js';
export * from './plugin-marketplace-cli.js';
// 外部来源会话增量反向索引（B5）：可注入来源适配器（discover/read 两段式）+ 增量索引器
// （稳定身份幂等 + 先占位后读的竞态守卫 + 游标水位续跑 + 越界/损坏/超大 fail closed）。
export * from './external-session-index-types.js';
export * from './external-session-source.js';
export * from './external-session-index-store.js';
export * from './external-session-index.js';
// 记忆 recall（缺口 2）：工作区事实记忆的清单扫描 + 确定性相关性选择 + 有界读取 + 陈旧标注。
// 与 memory-ledger 的分工：账本管 SQLite 里受审查的记录，本层管工作区里可编辑的 .md 文件。
// agent-runtime 不调模型，故默认选择器是确定性打分；`MemoryRecallSelector` 留接缝给上层注入。
export * from './memory-recall-contract.js';
export * from './memory-recall.js';
export * from './infrastructure/node-memory-file-system.js';
// 运行期任务台账（缺口 3）：登记 / 独立观察者等待终态 / 就地后台化 / 消息投递 / 迟到完成围栏。
// 与 recoverable-task-runtime 的分工：那个是「DAG 怎么跑完 + 怎么崩溃后接着跑」（执行器 + 持久化），
// 本层是「任务在跑但我现在没在看它」（台账 + 观察）。与 provider-sdk 的 listBackgroundWork 的分工：
// 那个是「问 provider 那边还有什么没完」，本层是「我自己的任务台账」，不依赖 provider 也不调模型。
export * from './runtime-task-contract.js';
export * from './runtime-task-registry.js';
export * from './runtime-task-notification.js';
// 压缩触发层（缺口 4）：补齐 baseline 2 上下文治理的「何时压、压哪一档、压不动怎么办」。
// 与 microcompact 的分工：那个是「档位」（清哪些工具结果），本层是「触发」（该不该动手 + 择档 + 熔断）。
// 与 context-budgeter 的分工：那个在装配后按预算裁剪（反应式），本层是前视的阈值判定。
export * from './compaction-policy-contract.js';
export * from './compaction-policy.js';
