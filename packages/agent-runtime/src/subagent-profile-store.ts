// 一个文件=一种作用：子代理 profile 的持久化，接 memory-ledger。
//
// 方案原文要求「profile 存储接 memory-ledger」：用户/项目 profile 以 durable_fact
// 记忆的形式落账，复用 MemoryLedger 的 append-only 修订与 supersede 链，不另建存储。
// 内置 profile 不落账——它们是代码常量，不是用户事实；同名内置仍由 normalizeAgentProfiles
// 在内存中覆盖（见 subagent-profile.ts）。

import {
  copyMemoryRecord,
  MemoryLedger,
  type MemoryRecord,
} from './memory-ledger.js';
import type {
  SubagentMemoryScope,
  SubagentModelSelection,
  SubagentProfile,
  SubagentProfileColor,
} from './subagent-profile.js';

const STORE_AGENT_ID = 'subagent-profile-store';
const PROFILE_ID_PREFIX = 'subagent-profile';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface SubagentProfileStoreSaveOptions {
  workspaceId: string;
  at: number;
}

export interface SubagentProfileStoreListOptions {
  workspaceId: string;
}

/** profile 存储边界：save 追加修订，list 返回该工作区最新的已确认 profile。 */
export interface SubagentProfileStore {
  save(profile: SubagentProfile, options: SubagentProfileStoreSaveOptions): MemoryRecord;
  list(options: SubagentProfileStoreListOptions): readonly SubagentProfile[];
}

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

/** 固定字段顺序的序列化：内容不变则 payload 不变，save 才能稳定判等。 */
function serializeProfile(profile: SubagentProfile): Record<string, unknown> {
  return {
    name: profile.name,
    description: profile.description,
    source: profile.source,
    systemPrompt: profile.systemPrompt,
    ...(profile.color ? { color: profile.color } : {}),
    ...(profile.injectAgentsMd === undefined ? {} : { injectAgentsMd: profile.injectAgentsMd }),
    ...(profile.tools ? { tools: [...profile.tools] } : {}),
    ...(profile.disallowedTools ? { disallowedTools: [...profile.disallowedTools] } : {}),
    ...(profile.modelSelection ? { modelSelection: { ...profile.modelSelection } } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    ...(profile.memory ? { memory: profile.memory } : {}),
    ...(profile.path ? { path: profile.path } : {}),
  };
}

function deserializeProfile(content: string): SubagentProfile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name : undefined;
  const description = typeof value.description === 'string' ? value.description : undefined;
  const source = value.source === 'user' || value.source === 'project' ? value.source : undefined;
  const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt : undefined;
  if (!name || description === undefined || !source || systemPrompt === undefined) return undefined;
  return {
    name,
    description,
    source,
    systemPrompt,
    ...(typeof value.color === 'string' ? { color: value.color as SubagentProfileColor } : {}),
    ...(typeof value.injectAgentsMd === 'boolean' ? { injectAgentsMd: value.injectAgentsMd } : {}),
    ...(Array.isArray(value.tools) ? { tools: value.tools.filter((item): item is string => typeof item === 'string') } : {}),
    ...(Array.isArray(value.disallowedTools)
      ? { disallowedTools: value.disallowedTools.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(isModelSelection(value.modelSelection) ? { modelSelection: value.modelSelection } : {}),
    ...(typeof value.maxTurns === 'number' ? { maxTurns: value.maxTurns } : {}),
    ...(typeof value.memory === 'string' ? { memory: value.memory as SubagentMemoryScope } : {}),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
  };
}

function isModelSelection(value: unknown): value is SubagentModelSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SubagentModelSelection).providerId === 'string' &&
    typeof (value as SubagentModelSelection).modelId === 'string'
  );
}

function profileKey(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/gu, '-').slice(0, 96);
  return `${PROFILE_ID_PREFIX}.${sanitized}`;
}

/**
 * 以 memory-ledger 为唯一后端的 profile 存储。每次内容变更写入一条新修订记录并
 * supersede 旧记录，因此历史可回放；相同内容重复 save 是幂等的。
 */
export class MemoryLedgerSubagentProfileStore implements SubagentProfileStore {
  constructor(private readonly ledger: MemoryLedger) {}

  save(profile: SubagentProfile, options: SubagentProfileStoreSaveOptions): MemoryRecord {
    if (profile.source === 'built-in') {
      throw new Error('内置 profile 不落账：它们是代码常量，不是用户事实');
    }
    assertIdentifier(options.workspaceId, 'workspaceId');
    assertEpoch(options.at, 'at');

    const content = JSON.stringify(serializeProfile(profile));
    const prior = this.recordsFor(options.workspaceId, profile.name);
    const current = prior.find((record) => record.status === 'confirmed');
    if (current && current.content === content) return copyMemoryRecord(current);

    const id = `${profileKey(profile.name)}.r${prior.length + 1}`;
    if (current) this.ledger.supersede(current.id, options.at);
    this.ledger.addCandidate({
      id,
      kind: 'durable_fact',
      scope: { agentId: STORE_AGENT_ID, workspaceId: options.workspaceId, path: profile.name },
      content,
      estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
      provenance: {
        sourceType: profile.source === 'user' ? 'user' : 'system',
        sourceId: id,
        trust: profile.source === 'user' ? 'user_confirmed' : 'trusted_local',
      },
      at: options.at,
    });
    return this.ledger.confirm(id, options.at);
  }

  list(options: SubagentProfileStoreListOptions): readonly SubagentProfile[] {
    assertIdentifier(options.workspaceId, 'workspaceId');
    return this.ledger
      .list()
      .filter(
        (record) =>
          record.status === 'confirmed' &&
          record.scope.agentId === STORE_AGENT_ID &&
          record.scope.workspaceId === options.workspaceId,
      )
      .flatMap((record) => {
        const profile = deserializeProfile(record.content);
        return profile ? [profile] : [];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** 该工作区下某 profile 名对应的全部修订记录（含已 supersede 的历史）。 */
  private recordsFor(workspaceId: string, profileName: string): readonly MemoryRecord[] {
    return this.ledger.list().filter(
      (record) =>
        record.scope.agentId === STORE_AGENT_ID &&
        record.scope.workspaceId === workspaceId &&
        record.scope.path === profileName,
    );
  }
}
