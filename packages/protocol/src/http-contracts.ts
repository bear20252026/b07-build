import type { AgentProfileId, Capability, ExecutionAuthorityMode } from './types.js';

export const GATEWAY_HTTP_CONTRACT_VERSION = 1 as const;
const MAX_TASK_GOAL_LENGTH = 12_000;
const PROFILE_IDS: readonly AgentProfileId[] = ['build', 'plan', 'explore'];
const AUTHORITY_MODES: readonly ExecutionAuthorityMode[] = ['plan', 'review', 'automate', 'admin'];
const CAPABILITIES: readonly Capability[] = ['document.parse', 'model.chat', 'filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control'];

export interface AdministratorLeaseIntentV1 {
  operatorId: string;
  allowedCapabilities: readonly Capability[];
  /** 仅在 Gateway 进程内散列；不落入租约、trajectory 或日志正文。 */
  reason: string;
}

export interface TaskSubmitIntentV1 {
  schemaVersion: typeof GATEWAY_HTTP_CONTRACT_VERSION;
  goal: string;
  profileId: AgentProfileId;
  authorityMode: ExecutionAuthorityMode;
  administratorLease?: AdministratorLeaseIntentV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isProfileId(value: unknown): value is AgentProfileId {
  return typeof value === 'string' && (PROFILE_IDS as readonly string[]).includes(value);
}

function isAuthorityMode(value: unknown): value is ExecutionAuthorityMode {
  return typeof value === 'string' && (AUTHORITY_MODES as readonly string[]).includes(value);
}

function decodeAdministratorLease(value: unknown): AdministratorLeaseIntentV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => !['operatorId', 'allowedCapabilities', 'reason'].includes(key))) {
    throw new Error('administratorLease 必须是受限的 operatorId、allowedCapabilities、reason object');
  }
  if (typeof value.operatorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.operatorId)) throw new Error('administratorLease.operatorId 无效');
  if (!Array.isArray(value.allowedCapabilities) || value.allowedCapabilities.length === 0 || value.allowedCapabilities.some((capability) => typeof capability !== 'string' || !(CAPABILITIES as readonly string[]).includes(capability)) || new Set(value.allowedCapabilities).size !== value.allowedCapabilities.length) {
    throw new Error('administratorLease.allowedCapabilities 必须是无重复的已声明 capability');
  }
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 512) throw new Error('administratorLease.reason 必须是 1-512 字符的非空维护理由');
  return { operatorId: value.operatorId, allowedCapabilities: [...value.allowedCapabilities] as Capability[], reason: value.reason.trim() };
}

/**
 * Gateway 写入 intent 的版本化最小 schema。它只验证形状，绝不替代 Policy、审批、预算或执行器授权。
 * 拒绝未声明字段，避免 HTTP 通道在前后端独立演进时发生静默语义漂移。
 */
export function decodeTaskSubmitIntentV1(value: unknown): TaskSubmitIntentV1 {
  if (!isRecord(value)) throw new Error('任务提交 body 必须是 JSON object');
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion', 'goal', 'profileId', 'authorityMode', 'administratorLease'].includes(key))) {
    throw new Error('任务提交包含未声明字段');
  }
  if (value.schemaVersion !== GATEWAY_HTTP_CONTRACT_VERSION) {
    throw new Error(`不支持的任务提交 HTTP contract 版本：${String(value.schemaVersion)}`);
  }
  if (typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > MAX_TASK_GOAL_LENGTH) {
    throw new Error(`goal 必须是 1-${MAX_TASK_GOAL_LENGTH} 字符的非空文本`);
  }
  if (!isProfileId(value.profileId)) throw new Error('profileId 必须是已声明的 Agent Profile');
  if (value.authorityMode !== undefined && !isAuthorityMode(value.authorityMode)) throw new Error('authorityMode 必须是已声明的执行权限');
  const authorityMode = value.authorityMode ?? 'review';
  const administratorLease = value.administratorLease === undefined ? undefined : decodeAdministratorLease(value.administratorLease);
  if (authorityMode === 'admin' && !administratorLease) throw new Error('Admin Authority 必须显式提交受限管理员租约申请');
  if (authorityMode !== 'admin' && administratorLease) throw new Error('只有 Admin Authority 可以提交管理员租约申请');
  return {
    schemaVersion: GATEWAY_HTTP_CONTRACT_VERSION,
    goal: value.goal.trim(),
    profileId: value.profileId,
    // 旧客户端不会意外进入自动或管理员执行；缺省仅保留既有逐步审批姿态。
    authorityMode,
    administratorLease,
  };
}
