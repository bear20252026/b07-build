/**
 * Agent Adapter 模块的稳定公共 facade。
 * 实现按 manifest/session/mailbox 控制面归入 modules/agent-adapter，避免根目录混入跨领域聚合。
 */
export * from './modules/agent-adapter/control-plane.js';
