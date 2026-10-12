// 一个文件=一种作用：协议包公共导出边界。
export * from './types.js';
export * from './task-event-validator.js';
export * from './http-contracts.js';
// 结构化补丁方言：模型与宿主之间的线协议契约（解析/应用/安全策略）。
export * from './code-editing/patch-parser.js';
export * from './code-editing/patch-apply.js';
export * from './code-editing/patch-policy.js';
