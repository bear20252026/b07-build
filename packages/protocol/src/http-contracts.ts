import type { AgentProfileId } from './types.js';

export const GATEWAY_HTTP_CONTRACT_VERSION = 1 as const;
const MAX_TASK_GOAL_LENGTH = 12_000;
const PROFILE_IDS: readonly AgentProfileId[] = ['build', 'plan', 'explore'];

export interface TaskSubmitIntentV1 {
  schemaVersion: typeof GATEWAY_HTTP_CONTRACT_VERSION;
  goal: string;
  profileId: AgentProfileId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isProfileId(value: unknown): value is AgentProfileId {
  return typeof value === 'string' && (PROFILE_IDS as readonly string[]).includes(value);
}

/**
 * Gateway 写入 intent 的版本化最小 schema。它只验证形状，绝不替代 Policy、审批、预算或执行器授权。
 * 拒绝未声明字段，避免 HTTP 通道在前后端独立演进时发生静默语义漂移。
 */
export function decodeTaskSubmitIntentV1(value: unknown): TaskSubmitIntentV1 {
  if (!isRecord(value)) throw new Error('任务提交 body 必须是 JSON object');
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion', 'goal', 'profileId'].includes(key))) {
    throw new Error('任务提交包含未声明字段');
  }
  if (value.schemaVersion !== GATEWAY_HTTP_CONTRACT_VERSION) {
    throw new Error(`不支持的任务提交 HTTP contract 版本：${String(value.schemaVersion)}`);
  }
  if (typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > MAX_TASK_GOAL_LENGTH) {
    throw new Error(`goal 必须是 1-${MAX_TASK_GOAL_LENGTH} 字符的非空文本`);
  }
  if (!isProfileId(value.profileId)) throw new Error('profileId 必须是已声明的 Agent Profile');
  return { schemaVersion: GATEWAY_HTTP_CONTRACT_VERSION, goal: value.goal.trim(), profileId: value.profileId };
}
