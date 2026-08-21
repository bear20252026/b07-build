import type { AgentProfileId } from '@awo/protocol';

/**
 * Workbench 首页明确支持的用户可选 Profile。
 *
 * 此 allowlist 不从 i18n 对象键名推导，避免 `selectAria` 等辅助字段，或未来内部/管理员类型，
 * 被误当作可点击 Agent。它仅影响 UI 展示，绝不更改 Gateway 的权限裁决。
 */
export const WORKBENCH_PROFILE_IDS = ['build', 'plan', 'explore', 'reader'] as const satisfies readonly AgentProfileId[];
