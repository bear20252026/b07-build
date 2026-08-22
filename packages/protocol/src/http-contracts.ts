import { INPUT_PROVENANCE_SCHEMA_VERSION } from './types.js';
import type { AgentProfileId, Capability, ContentTrust, ExecutionAuthorityMode, InputProvenanceV1, InputSourceKind } from './types.js';

export const GATEWAY_HTTP_CONTRACT_VERSION = 1 as const;
const MAX_TASK_GOAL_LENGTH = 12_000;
const PROFILE_IDS: readonly AgentProfileId[] = ['build', 'plan', 'explore', 'reader'];
const AUTHORITY_MODES: readonly ExecutionAuthorityMode[] = ['plan', 'review', 'automate', 'admin'];
const CAPABILITIES: readonly Capability[] = ['document.parse', 'model.chat', 'filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control'];
const CONTENT_TRUSTS: readonly ContentTrust[] = ['operator-authored', 'workspace-controlled', 'external-untrusted', 'derived-untrusted'];
const INPUT_SOURCE_KINDS: readonly InputSourceKind[] = ['operator', 'workspace', 'web', 'upload', 'knowledge', 'tool-output', 'provider-output'];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;

export interface AdministratorLeaseIntentV1 {
  operatorId: string;
  allowedCapabilities: readonly Capability[];
  /** 仅在 Gateway 进程内散列；不落入租约、trajectory 或日志正文。 */
  reason: string;
}

export interface TaskUploadIntentV1 {
  id: string;
  name: string;
  /** 仅限本机 Gateway 任务提交的 base64 文本/代码字节；摘要由 Gateway 对解码字节重新计算。 */
  contentBase64: string;
}

export interface TaskSubmitIntentV1 {
  schemaVersion: typeof GATEWAY_HTTP_CONTRACT_VERSION;
  goal: string;
  profileId: AgentProfileId;
  authorityMode: ExecutionAuthorityMode;
  administratorLease?: AdministratorLeaseIntentV1;
  /** 浏览器只能声明外部/派生的不可信摘要；可信来源由 Gateway 内部构造。 */
  inputProvenance: readonly InputProvenanceV1[];
  uploads?: readonly TaskUploadIntentV1[];
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

function decodeInputProvenance(value: unknown): InputProvenanceV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => !['schemaVersion', 'inputId', 'trust', 'sourceKind', 'contentDigest'].includes(key))) {
    throw new Error('inputProvenance 条目必须是受限的摘要 metadata object');
  }
  if (value.schemaVersion !== INPUT_PROVENANCE_SCHEMA_VERSION) throw new Error('inputProvenance.schemaVersion 不受支持');
  if (typeof value.inputId !== 'string' || !IDENTIFIER.test(value.inputId)) throw new Error('inputProvenance.inputId 无效');
  if (typeof value.trust !== 'string' || !(CONTENT_TRUSTS as readonly string[]).includes(value.trust)) throw new Error('inputProvenance.trust 必须是已声明信任分类');
  if (typeof value.sourceKind !== 'string' || !(INPUT_SOURCE_KINDS as readonly string[]).includes(value.sourceKind)) throw new Error('inputProvenance.sourceKind 必须是已声明来源类别');
  if (typeof value.contentDigest !== 'string' || !SHA256_DIGEST.test(value.contentDigest)) throw new Error('inputProvenance.contentDigest 必须是 SHA-256 十六进制摘要');
  const trust = value.trust as ContentTrust;
  const sourceKind = value.sourceKind as InputSourceKind;
  if ((trust === 'operator-authored' && sourceKind !== 'operator') || (trust === 'workspace-controlled' && sourceKind !== 'workspace')) {
    throw new Error('inputProvenance trust 与 sourceKind 不匹配');
  }
  if (trust === 'external-untrusted' && !['web', 'upload', 'knowledge'].includes(sourceKind)) {
    throw new Error('external-untrusted 只能来自 web、upload 或 knowledge');
  }
  if (trust === 'derived-untrusted' && !['tool-output', 'provider-output', 'knowledge'].includes(sourceKind)) {
    throw new Error('derived-untrusted 只能来自 tool-output、provider-output 或 knowledge');
  }
  // 普通 HTTP/body 不是可信来源证明；受信任务输入仅能由 Gateway/桌面宿主内部构造。
  if (trust === 'operator-authored' || trust === 'workspace-controlled') throw new Error('HTTP 不得自声明 operator/workspace trusted input');
  return { schemaVersion: INPUT_PROVENANCE_SCHEMA_VERSION, inputId: value.inputId, trust, sourceKind, contentDigest: value.contentDigest };
}

function decodeTaskUpload(value: unknown): TaskUploadIntentV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'name', 'contentBase64'].includes(key))) throw new Error('upload 必须是受限文件 metadata 与 base64 object');
  if (typeof value.id !== 'string' || !IDENTIFIER.test(value.id)) throw new Error('upload.id 无效');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || /[\\/\0\r\n]/.test(value.name) || value.name === '.' || value.name === '..') throw new Error('upload.name 必须是安全文件名');
  if (typeof value.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.contentBase64) || value.contentBase64.length > 350_000) throw new Error('upload.contentBase64 无效或超过 256KiB 文本上传上限');
  return { id: value.id, name: value.name.trim(), contentBase64: value.contentBase64 };
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
  if (keys.some((key) => !['schemaVersion', 'goal', 'profileId', 'authorityMode', 'administratorLease', 'inputProvenance', 'uploads'].includes(key))) {
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
  if (value.inputProvenance !== undefined && (!Array.isArray(value.inputProvenance) || value.inputProvenance.length > 16)) throw new Error('inputProvenance 必须是至多 16 条的数组');
  const inputProvenance = (value.inputProvenance ?? []).map(decodeInputProvenance);
  if (new Set(inputProvenance.map((input) => input.inputId)).size !== inputProvenance.length) throw new Error('inputProvenance.inputId 不可重复');
  if (value.uploads !== undefined && (!Array.isArray(value.uploads) || value.uploads.length > 8)) throw new Error('uploads 必须是至多 8 项的数组');
  const uploads = (value.uploads ?? []).map(decodeTaskUpload);
  if (new Set(uploads.map((upload) => upload.id)).size !== uploads.length) throw new Error('upload.id 不可重复');
  if (authorityMode === 'admin' && !administratorLease) throw new Error('Admin Authority 必须显式提交受限管理员租约申请');
  if (authorityMode !== 'admin' && administratorLease) throw new Error('只有 Admin Authority 可以提交管理员租约申请');
  return {
    schemaVersion: GATEWAY_HTTP_CONTRACT_VERSION,
    goal: value.goal.trim(),
    profileId: value.profileId,
    // 旧客户端不会意外进入自动或管理员执行；缺省仅保留既有逐步审批姿态。
    authorityMode,
    administratorLease,
    inputProvenance: inputProvenance.sort((left, right) => left.inputId.localeCompare(right.inputId)),
    ...(value.uploads === undefined ? {} : { uploads: uploads.sort((left, right) => left.id.localeCompare(right.id)) }),
  };
}
