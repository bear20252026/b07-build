// 一个文件=一种作用：代理运行时公共导出边界。
export * from './executor.js';
export * from './capability-policy.js';
export * from './permission-chain.js';
export * from './permission-broker.js';
export * from './agent-profile.js';
export * from './controlled-tool-runner.js';
export * from './context-budgeter.js';
export * from './context-assembly.js';
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
