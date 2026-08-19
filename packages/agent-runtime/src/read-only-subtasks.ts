import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Capability,
  CapabilityEvaluation,
  CapabilityPolicy,
  CapabilityRequest,
} from '@awo/protocol';

export type ReadOnlySubtaskRole = 'explore' | 'scout';
export type ReadOnlySubtaskStatus = 'created' | 'running' | 'completed' | 'failed';
export type SubtaskCitationKind = 'knowledge' | 'workspace' | 'task_output';

export interface ReadOnlySubtaskBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
}

export interface ReadOnlySubtaskRequest {
  subtaskId: string;
  parentTaskId: string;
  parentRunId: string;
  role: ReadOnlySubtaskRole;
  goal: string;
  budget: ReadOnlySubtaskBudget;
  at: number;
}

export interface SubtaskCitation {
  kind: SubtaskCitationKind;
  sourceId: string;
  sourceUri: string;
  excerpt: string;
}

export interface ReadOnlySubtaskReport {
  summary: string;
  estimatedOutputTokens: number;
  citations: readonly SubtaskCitation[];
}

export interface ReadOnlySubtaskSnapshot {
  schemaVersion: 1;
  subtaskId: string;
  parentTaskId: string;
  parentRunId: string;
  role: ReadOnlySubtaskRole;
  status: ReadOnlySubtaskStatus;
  goal: string;
  budget: Readonly<ReadOnlySubtaskBudget>;
  revision: number;
  createdAt: number;
  updatedAt: number;
  report?: ReadOnlySubtaskReport;
  errorCode?: 'worker_failed' | 'output_rejected';
}

export interface SubtaskSnapshotStore {
  load(subtaskId: string): ReadOnlySubtaskSnapshot | undefined;
  save(snapshot: ReadOnlySubtaskSnapshot): void;
  history(subtaskId: string): readonly ReadOnlySubtaskSnapshot[];
}

export interface ReadOnlySubtaskContext {
  subtaskId: string;
  parentTaskId: string;
  parentRunId: string;
  role: ReadOnlySubtaskRole;
  goal: string;
  budget: Readonly<ReadOnlySubtaskBudget>;
  /** 只读策略由服务注入；worker 必须经此边界评估任何工具意图。 */
  policy: CapabilityPolicy;
  allowedCapabilities: readonly ('document.parse' | 'model.chat' | 'filesystem.read')[];
}

export interface ReadOnlySubtaskWorker {
  run(context: ReadOnlySubtaskContext): Promise<ReadOnlySubtaskReport>;
}

export interface ParentSubtaskSummaryReference {
  subtaskId: string;
  parentTaskId: string;
  parentRunId: string;
  role: ReadOnlySubtaskRole;
  summary: string;
  citations: readonly SubtaskCitation[];
  estimatedTokens: number;
  canAuthorize: false;
}

const ALLOWED_CAPABILITIES = ['document.parse', 'model.chat', 'filesystem.read'] as const;
const ALLOWED = new Set<Capability>(ALLOWED_CAPABILITIES);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正安全整数`);
}

function copyCitation(citation: SubtaskCitation): SubtaskCitation {
  return { ...citation };
}

function copyReport(report: ReadOnlySubtaskReport): ReadOnlySubtaskReport {
  return { ...report, citations: report.citations.map(copyCitation) };
}

function copySnapshot(snapshot: ReadOnlySubtaskSnapshot): ReadOnlySubtaskSnapshot {
  return {
    ...snapshot,
    budget: { ...snapshot.budget },
    report: snapshot.report ? copyReport(snapshot.report) : undefined,
  };
}

function validateBudget(budget: ReadOnlySubtaskBudget): void {
  assertPositiveInteger(budget.maxInputTokens, 'budget.maxInputTokens');
  assertPositiveInteger(budget.maxOutputTokens, 'budget.maxOutputTokens');
  assertPositiveInteger(budget.maxToolCalls, 'budget.maxToolCalls');
}

function validateRequest(request: ReadOnlySubtaskRequest): void {
  assertIdentifier(request.subtaskId, 'subtaskId');
  assertIdentifier(request.parentTaskId, 'parentTaskId');
  assertIdentifier(request.parentRunId, 'parentRunId');
  if (request.role !== 'explore' && request.role !== 'scout') throw new Error('role 必须是 explore 或 scout');
  if (!request.goal.trim() || request.goal.trim().length > 4_000) throw new Error('goal 必须是 1-4000 个字符');
  validateBudget(request.budget);
  assertEpoch(request.at, 'at');
}

function validateReport(report: ReadOnlySubtaskReport, budget: ReadOnlySubtaskBudget): void {
  if (!report.summary.trim() || report.summary.trim().length > 8_000) throw new Error('summary 必须是 1-8000 个字符');
  if (!Number.isSafeInteger(report.estimatedOutputTokens) || report.estimatedOutputTokens < 0) {
    throw new Error('estimatedOutputTokens 必须是非负安全整数');
  }
  if (report.estimatedOutputTokens > budget.maxOutputTokens) throw new Error('子任务摘要超出 maxOutputTokens 预算');
  if (report.citations.length > 20) throw new Error('子任务摘要最多携带 20 条引用');
  for (const citation of report.citations) {
    if (!['knowledge', 'workspace', 'task_output'].includes(citation.kind)) throw new Error('citation.kind 无效');
    assertIdentifier(citation.sourceId, 'citation.sourceId');
    if (!citation.sourceUri.trim() || citation.sourceUri.length > 1_024) throw new Error('citation.sourceUri 无效');
    if (!citation.excerpt.trim() || citation.excerpt.length > 320) throw new Error('citation.excerpt 必须是 1-320 个字符');
  }
}

/**
 * 子任务的能力上限，不合并 parent profile，也不接受 require_approval；任何非只读意图都会稳定拒绝。
 * 该策略是能力收紧器，不能被角色、摘要或父任务授权扩大。
 */
export class ReadOnlySubtaskPolicy implements CapabilityPolicy {
  evaluate(request: CapabilityRequest): CapabilityEvaluation {
    if (ALLOWED.has(request.capability)) return { decision: 'allow', reason: '只读子任务允许本地解析、模型推理和文件读取' };
    return { decision: 'deny', reason: `只读子任务禁止 ${request.capability}；不得写入、联网、执行 Shell 或控制浏览器` };
  }
}

export class InMemorySubtaskSnapshotStore implements SubtaskSnapshotStore {
  private readonly current = new Map<string, ReadOnlySubtaskSnapshot>();
  private readonly revisions = new Map<string, ReadOnlySubtaskSnapshot[]>();

  load(subtaskId: string): ReadOnlySubtaskSnapshot | undefined {
    const snapshot = this.current.get(subtaskId);
    return snapshot ? copySnapshot(snapshot) : undefined;
  }

  save(snapshot: ReadOnlySubtaskSnapshot): void {
    const previous = this.current.get(snapshot.subtaskId);
    if (!previous && snapshot.revision !== 1) throw new Error('新子任务快照 revision 必须为 1');
    if (previous && snapshot.revision !== previous.revision + 1) throw new Error('子任务快照 revision 必须追加递增');
    const copied = copySnapshot(snapshot);
    this.current.set(snapshot.subtaskId, copied);
    const history = this.revisions.get(snapshot.subtaskId) ?? [];
    history.push(copySnapshot(copied));
    this.revisions.set(snapshot.subtaskId, history);
  }

  history(subtaskId: string): readonly ReadOnlySubtaskSnapshot[] {
    return (this.revisions.get(subtaskId) ?? []).map(copySnapshot);
  }
}

/** SQLite append-only 子任务快照，供父任务恢复和后续审查；不保存完整 worker transcript。 */
export class SqliteSubtaskSnapshotStore implements SubtaskSnapshotStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS read_only_subtask_revisions (
        subtask_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (subtask_id, revision)
      );
    `);
  }

  load(subtaskId: string): ReadOnlySubtaskSnapshot | undefined {
    assertIdentifier(subtaskId, 'subtaskId');
    const row = this.db.prepare(`
      SELECT snapshot_json FROM read_only_subtask_revisions
      WHERE subtask_id = ? ORDER BY revision DESC LIMIT 1
    `).get(subtaskId) as { snapshot_json: string } | undefined;
    return row ? copySnapshot(JSON.parse(row.snapshot_json) as ReadOnlySubtaskSnapshot) : undefined;
  }

  save(snapshot: ReadOnlySubtaskSnapshot): void {
    const current = this.load(snapshot.subtaskId);
    if (!current && snapshot.revision !== 1) throw new Error('新子任务快照 revision 必须为 1');
    if (current && snapshot.revision !== current.revision + 1) throw new Error('子任务快照 revision 必须追加递增');
    this.db.prepare(`
      INSERT INTO read_only_subtask_revisions (subtask_id, revision, snapshot_json) VALUES (?, ?, ?)
    `).run(snapshot.subtaskId, snapshot.revision, JSON.stringify(copySnapshot(snapshot)));
  }

  history(subtaskId: string): readonly ReadOnlySubtaskSnapshot[] {
    assertIdentifier(subtaskId, 'subtaskId');
    const rows = this.db.prepare(`
      SELECT snapshot_json FROM read_only_subtask_revisions
      WHERE subtask_id = ? ORDER BY revision ASC
    `).all(subtaskId) as unknown as readonly { snapshot_json: string }[];
    return rows.map((row) => copySnapshot(JSON.parse(row.snapshot_json) as ReadOnlySubtaskSnapshot));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 父任务只能以 `summaryReference()` 消费已完成子任务的短摘要和 citation，不能取得 worker 的隐藏状态或工具句柄。
 */
export class ReadOnlySubtaskService {
  private readonly policy = new ReadOnlySubtaskPolicy();

  constructor(private readonly store: SubtaskSnapshotStore) {}

  spawn(request: ReadOnlySubtaskRequest): ReadOnlySubtaskSnapshot {
    validateRequest(request);
    if (this.store.load(request.subtaskId)) throw new Error(`子任务 ${request.subtaskId} 已存在`);
    const snapshot: ReadOnlySubtaskSnapshot = {
      schemaVersion: 1,
      subtaskId: request.subtaskId,
      parentTaskId: request.parentTaskId,
      parentRunId: request.parentRunId,
      role: request.role,
      status: 'created',
      goal: request.goal.trim(),
      budget: { ...request.budget },
      revision: 1,
      createdAt: request.at,
      updatedAt: request.at,
    };
    this.store.save(snapshot);
    return copySnapshot(snapshot);
  }

  async run(subtaskId: string, worker: ReadOnlySubtaskWorker, at: number): Promise<ReadOnlySubtaskSnapshot> {
    assertIdentifier(subtaskId, 'subtaskId');
    assertEpoch(at, 'at');
    const existing = this.require(subtaskId);
    if (existing.status === 'completed') return existing;
    if (existing.status === 'failed') throw new Error(`子任务 ${subtaskId} 已失败；请创建新 subtaskId 重试`);
    const running: ReadOnlySubtaskSnapshot = { ...existing, status: 'running', revision: existing.revision + 1, updatedAt: at };
    this.store.save(running);
    const context: ReadOnlySubtaskContext = {
      subtaskId: running.subtaskId,
      parentTaskId: running.parentTaskId,
      parentRunId: running.parentRunId,
      role: running.role,
      goal: running.goal,
      budget: { ...running.budget },
      policy: this.policy,
      allowedCapabilities: ALLOWED_CAPABILITIES,
    };
    try {
      const report = await worker.run(context);
      validateReport(report, running.budget);
      const completed: ReadOnlySubtaskSnapshot = {
        ...running,
        status: 'completed',
        revision: running.revision + 1,
        updatedAt: at,
        report: copyReport({ ...report, summary: report.summary.trim() }),
      };
      this.store.save(completed);
      return copySnapshot(completed);
    } catch (error) {
      const failed: ReadOnlySubtaskSnapshot = {
        ...running,
        status: 'failed',
        revision: running.revision + 1,
        updatedAt: at,
        errorCode: error instanceof Error && error.message.includes('预算') ? 'output_rejected' : 'worker_failed',
      };
      this.store.save(failed);
      return copySnapshot(failed);
    }
  }

  snapshot(subtaskId: string): ReadOnlySubtaskSnapshot | undefined {
    assertIdentifier(subtaskId, 'subtaskId');
    const snapshot = this.store.load(subtaskId);
    return snapshot ? copySnapshot(snapshot) : undefined;
  }

  summaryReference(subtaskId: string): ParentSubtaskSummaryReference {
    const snapshot = this.require(subtaskId);
    if (snapshot.status !== 'completed' || !snapshot.report) throw new Error('父任务只能消费已完成只读子任务的摘要引用');
    return {
      subtaskId: snapshot.subtaskId,
      parentTaskId: snapshot.parentTaskId,
      parentRunId: snapshot.parentRunId,
      role: snapshot.role,
      summary: snapshot.report.summary,
      citations: snapshot.report.citations.map(copyCitation),
      estimatedTokens: snapshot.report.estimatedOutputTokens,
      canAuthorize: false,
    };
  }

  private require(subtaskId: string): ReadOnlySubtaskSnapshot {
    const snapshot = this.store.load(subtaskId);
    if (!snapshot) throw new Error(`子任务 ${subtaskId} 不存在`);
    return snapshot;
  }
}
