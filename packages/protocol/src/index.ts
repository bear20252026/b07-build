// 一个文件=一种作用：协议包公共导出边界。
export * from './types.js';
export * from './task-event-validator.js';
export * from './http-contracts.js';
// 结构化补丁方言：模型与宿主之间的线协议契约（解析/应用/安全策略）。
export * from './code-editing/patch-parser.js';
export * from './code-editing/patch-apply.js';
export * from './code-editing/patch-policy.js';
// MCP Apps 准入与隔离策略（宿主 iframe 沙箱）。
export * from './mcp-app-admission.js';
// MCP Apps 官方 postMessage 桥（ext-apps JSON-RPC，R4-02）。
export * from './mcp-app-bridge.js';
// 工具声明契约与注册表（ToolDescriptor / ToolRegistry）。
export * from './tool-contract.js';
// 会话日志收敛机：seq 连续、快照权威替换、缺口重订阅（借 ZCode V4 同步语义）。
export * from './session-protocol/session-limits.js';
export * from './session-protocol/session-log-sync.js';
// 会话命令信封与客户端幂等表（commandId 复用 + CAS 基准）。
export * from './session-protocol/session-command.js';
export * from './session-protocol/session-command-ledger.js';
