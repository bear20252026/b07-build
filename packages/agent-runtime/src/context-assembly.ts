import { ContextBudgeter, type ContextBudgetResult } from './context-budgeter.js';
import {
  MemoryLedger,
  type MemoryContextSelection,
  type MemoryRecordDraft,
  type SelectedMemory,
} from './memory-ledger.js';
import type { SessionPersistenceMode } from './session-control-plane.js';

/** 模型输入从近到远的固定层次；层序也是同优先级时的稳定输出顺序。 */
export type ContextLayer =
  | 'L0_current_turn'
  | 'L1_session_working_set'
  | 'L2_durable_memory'
  | 'L3_knowledge'
  | 'L4_archive';

export type ContextInjectionReason =
  | 'current_turn'
  | 'session_working_set'
  | 'memory_preference'
  | 'memory_lexical_match'
  | 'memory_scope_match'
  | 'knowledge_retrieval'
  | 'archive_checkpoint';

export interface ContextSourceItem {
  /** 全局唯一、稳定的输入标识；不可由未受信任模型文本直接充当。 */
  id: string;
  content: string;
  estimatedTokens: number;
  /** 分数只在同一层内排序；L0–L4 层序绝不由它打破。 */
  relevance?: number;
  citations?: readonly string[];
}

export interface ContextAssemblySession {
  agentId: string;
  workspaceId: string;
  sessionId?: string;
  persistence: SessionPersistenceMode;
}

export interface ContextAssemblyRequest {
  taskId: string;
  runId: string;
  at: number;
  query: string;
  session: Readonly<ContextAssemblySession>;
  maxTokens: number;
  maxPreferenceTokens: number;
  maxDurableMemoryTokens: number;
  currentTurn: readonly ContextSourceItem[];
  workingSet?: readonly ContextSourceItem[];
  knowledge?: readonly ContextSourceItem[];
  archive?: readonly ContextSourceItem[];
}

export interface ContextInjection {
  id: string;
  layer: ContextLayer;
  content: string;
  estimatedTokens: number;
  reason: ContextInjectionReason;
  citations: readonly string[];
}

export interface ContextOmission {
  id: string;
  layer: ContextLayer;
  reason: 'budget_exceeded' | 'incognito_isolation' | 'unconfirmed_or_out_of_scope_memory';
}

export interface ContextAssemblyResult {
  injections: readonly ContextInjection[];
  omissions: readonly ContextOmission[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** 当有项因总预算省略时，调用方必须先准备 candidate 才可提交压缩写入。 */
  requiresCompactionPreparation: boolean;
  budget: ContextBudgetResult;
  memory: MemoryContextSelection | undefined;
}

/**
 * 压缩候选由独立抽取/摘要器产生；该模块只负责在真正压缩前将它写入 Memory Ledger 的 candidate 状态。
 * candidate 永远不会直接成为 L2 注入项，必须经过显式 confirm。
 */
export interface ContextCompactionProposal {
  candidate: MemoryRecordDraft;
  /** 必须覆盖本次被预算省略的 L1/L4 输入，避免把无关内容伪装为压缩检查点。 */
  coveredItemIds: readonly string[];
}

export type CompactionPreparation =
  | { status: 'not_required'; preservedWorkingSetIds: readonly string[] }
  | { status: 'skipped_incognito'; preservedWorkingSetIds: readonly string[] }
  | { status: 'prepared_candidate'; candidateId: string; preservedWorkingSetIds: readonly string[] }
  | { status: 'rejected'; reason: string; preservedWorkingSetIds: readonly string[] };

const LAYER_PRIORITY: Readonly<Record<ContextLayer, number>> = {
  L0_current_turn: 500,
  L1_session_working_set: 400,
  L2_durable_memory: 300,
  L3_knowledge: 200,
  L4_archive: 100,
};

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} 必须是 1-128 位安全标识符`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function copyCitations(citations: readonly string[] | undefined, fallback: string): readonly string[] {
  const values = citations?.filter((citation) => citation.trim().length > 0) ?? [];
  return values.length > 0 ? [...values] : [fallback];
}

function validateSourceItem(item: ContextSourceItem, layer: ContextLayer): void {
  assertIdentifier(item.id, `${layer}.id`);
  if (!item.content.trim()) throw new Error(`${layer} 输入 ${item.id} 的 content 不能为空`);
  assertNonNegativeInteger(item.estimatedTokens, `${layer}.estimatedTokens`);
  if (item.relevance !== undefined && !Number.isFinite(item.relevance)) {
    throw new Error(`${layer} 输入 ${item.id} 的 relevance 必须是有限数值`);
  }
}

function stableLayerItems(
  layer: ContextLayer,
  items: readonly ContextSourceItem[],
  reason: ContextInjectionReason,
): readonly ContextInjection[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (right.item.relevance ?? 0) - (left.item.relevance ?? 0) || left.index - right.index)
    .map(({ item }) => {
      validateSourceItem(item, layer);
      return {
        id: item.id,
        layer,
        content: item.content.trim(),
        estimatedTokens: item.estimatedTokens,
        reason,
        citations: copyCitations(item.citations, `${layer.toLocaleLowerCase() }://${item.id}`),
      };
    });
}

function memoryReason(memory: SelectedMemory): ContextInjectionReason {
  const reasons: Readonly<Record<SelectedMemory['reason'], ContextInjectionReason>> = {
    preference_budget: 'memory_preference',
    lexical_match: 'memory_lexical_match',
    scope_match: 'memory_scope_match',
  };
  return reasons[memory.reason];
}

function memoryInjection(memory: SelectedMemory): ContextInjection {
  const record = memory.record;
  return {
    id: `memory:${record.id}@${record.revision}`,
    layer: 'L2_durable_memory',
    content: record.excerpt,
    estimatedTokens: record.estimatedTokens,
    reason: memoryReason(memory),
    citations: copyCitations(record.provenance.citations, `memory://${record.id}@${record.revision}`),
  };
}

function workingSetIds(injections: readonly ContextInjection[]): readonly string[] {
  return injections
    .filter((injection) => injection.layer === 'L1_session_working_set')
    .map((injection) => injection.id);
}

/**
 * 本地优先的 L0–L4 装配器。
 *
 * 该类不调用模型、不压缩 transcript，也不授予能力；它产出可审计输入清单，并在需要压缩时要求调用者
 * 先将摘要结果写为 candidate。这样摘要失败不会改写 L1 工作集，candidate 未确认也不会影响后续 prompt。
 */
export class ContextAssembler {
  private readonly budgeter = new ContextBudgeter();

  constructor(private readonly memoryLedger: MemoryLedger) {}

  assemble(request: ContextAssemblyRequest): ContextAssemblyResult {
    assertIdentifier(request.taskId, 'taskId');
    assertIdentifier(request.runId, 'runId');
    assertIdentifier(request.session.agentId, 'session.agentId');
    assertIdentifier(request.session.workspaceId, 'session.workspaceId');
    if (request.session.sessionId !== undefined) assertIdentifier(request.session.sessionId, 'session.sessionId');
    assertNonNegativeInteger(request.at, 'at');
    assertNonNegativeInteger(request.maxTokens, 'maxTokens');
    assertNonNegativeInteger(request.maxPreferenceTokens, 'maxPreferenceTokens');
    assertNonNegativeInteger(request.maxDurableMemoryTokens, 'maxDurableMemoryTokens');

    const l0 = stableLayerItems('L0_current_turn', request.currentTurn, 'current_turn');
    const l1 = stableLayerItems('L1_session_working_set', request.workingSet ?? [], 'session_working_set');
    const isIncognito = request.session.persistence === 'incognito';
    const memory = isIncognito
      ? undefined
      : this.memoryLedger.selectForContext({
        agentId: request.session.agentId,
        workspaceId: request.session.workspaceId,
        sessionId: request.session.sessionId,
        query: request.query,
        at: request.at,
        maxPreferenceTokens: request.maxPreferenceTokens,
        maxOtherTokens: request.maxDurableMemoryTokens,
      });
    const l2 = memory
      ? [...memory.preferences, ...memory.otherMemories].map(memoryInjection)
      : [];
    const l3 = isIncognito ? [] : stableLayerItems('L3_knowledge', request.knowledge ?? [], 'knowledge_retrieval');
    const l4 = isIncognito ? [] : stableLayerItems('L4_archive', request.archive ?? [], 'archive_checkpoint');
    const all = [...l0, ...l1, ...l2, ...l3, ...l4];
    const ids = new Set<string>();
    for (const injection of all) {
      if (ids.has(injection.id)) throw new Error(`上下文注入 id 重复：${injection.id}`);
      ids.add(injection.id);
    }

    const currentTurnTokens = l0.reduce((total, injection) => total + injection.estimatedTokens, 0);
    if (currentTurnTokens > request.maxTokens) {
      throw new Error('L0 当前轮已超出总上下文预算；必须在装配前缩减当前输入');
    }

    const budget = this.budgeter.select({
      taskId: request.taskId,
      runId: request.runId,
      at: request.at,
      maxTokens: request.maxTokens,
      items: all.map((injection) => ({
        id: injection.id,
        estimatedTokens: injection.estimatedTokens,
        priority: LAYER_PRIORITY[injection.layer],
      })),
    });
    const retainedIds = new Set(budget.retained.map((item) => item.id));
    const injections = all.filter((injection) => retainedIds.has(injection.id));
    const omissions: ContextOmission[] = [
      ...budget.compacted.map((item) => {
        const injection = all.find((candidate) => candidate.id === item.id);
        if (!injection) throw new Error(`预算结果引用未知上下文项：${item.id}`);
        return { id: injection.id, layer: injection.layer, reason: 'budget_exceeded' as const };
      }),
      ...(isIncognito
        ? [
          ...(request.knowledge ?? []).map((item) => ({ id: item.id, layer: 'L3_knowledge' as const, reason: 'incognito_isolation' as const })),
          ...(request.archive ?? []).map((item) => ({ id: item.id, layer: 'L4_archive' as const, reason: 'incognito_isolation' as const })),
        ]
        : []),
      ...(memory?.omittedIds.map((id) => ({
        id: `memory:${id}`, layer: 'L2_durable_memory' as const, reason: 'unconfirmed_or_out_of_scope_memory' as const,
      })) ?? []),
    ];

    return {
      injections,
      omissions,
      estimatedTokensBefore: budget.estimatedTokensBefore,
      estimatedTokensAfter: budget.estimatedTokensAfter,
      requiresCompactionPreparation: budget.compacted.some((item) => {
        const injection = all.find((candidate) => candidate.id === item.id);
        return injection?.layer === 'L1_session_working_set' || injection?.layer === 'L4_archive';
      }),
      budget,
      memory,
    };
  }

  prepareCompaction(
    result: ContextAssemblyResult,
    session: Readonly<ContextAssemblySession>,
    proposal?: ContextCompactionProposal,
  ): CompactionPreparation {
    const preservedWorkingSetIds = workingSetIds(result.injections);
    if (!result.requiresCompactionPreparation) return { status: 'not_required', preservedWorkingSetIds };
    if (session.persistence === 'incognito') return { status: 'skipped_incognito', preservedWorkingSetIds };
    if (!proposal) return { status: 'rejected', reason: '压缩前必须生成 Memory Ledger candidate', preservedWorkingSetIds };
    if (proposal.candidate.scope.sessionPersistence === 'incognito') {
      return { status: 'rejected', reason: 'incognito candidate 不得写入持久账本', preservedWorkingSetIds };
    }
    const compactedIds = new Set(result.budget.compacted.map((item) => item.id));
    const covered = new Set(proposal.coveredItemIds);
    const requiresCoverage = result.omissions
      .filter((omission) => omission.reason === 'budget_exceeded' && (omission.layer === 'L1_session_working_set' || omission.layer === 'L4_archive'))
      .map((omission) => omission.id);
    if (requiresCoverage.some((id) => !compactedIds.has(id) || !covered.has(id))) {
      return { status: 'rejected', reason: 'candidate 必须覆盖被压缩的工作集或归档项', preservedWorkingSetIds };
    }
    try {
      const candidate = this.memoryLedger.addCandidate(proposal.candidate);
      return { status: 'prepared_candidate', candidateId: candidate.id, preservedWorkingSetIds };
    } catch (error) {
      return {
        status: 'rejected',
        reason: error instanceof Error ? error.message : 'candidate 写入失败',
        preservedWorkingSetIds,
      };
    }
  }
}
