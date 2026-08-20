import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TaskEvent } from '@awo/protocol';
import type { LocalTaskSnapshot, TaskRunStatus } from './recoverable-task-runtime.js';

export const RUN_WORKSPACE_LEDGER_SCHEMA_VERSION = 1 as const;

export type RunWorkspaceArtifactKind = 'tool-output' | 'declared-artifact';

/**
 * 运行级产出物的最小、脱敏投影。它从不保存 artifact path、tool args、tool output、prompt 或 secret。
 * reference 是受控逻辑引用，不是本地路径，也不能作为文件读取或副作用重放指令。
 */
export interface RunWorkspaceArtifactV1 {
  schemaVersion: typeof RUN_WORKSPACE_LEDGER_SCHEMA_VERSION;
  artifactLedgerId: string;
  sourceEventId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  reference: string;
  referenceDigest: string;
  kind: RunWorkspaceArtifactKind;
  status: 'available';
  at: number;
  containsSensitiveContent: false;
  canReplaySideEffects: false;
}

/**
 * 与一个已保存的 LocalTaskSnapshot 对应的不可变审查点。它是 metadata，不是授权、命令或恢复执行令牌。
 */
export interface RunCheckpointV1 {
  schemaVersion: typeof RUN_WORKSPACE_LEDGER_SCHEMA_VERSION;
  checkpointId: string;
  taskId: string;
  runId: string;
  attempt: number;
  status: TaskRunStatus;
  nodeOutcomeDigest: string;
  artifactManifestDigest: string;
  artifactCount: number;
  createdAt: number;
  canResume: boolean;
  canReplaySideEffects: false;
}

export interface RunWorkspaceLedgerStore {
  appendArtifact(artifact: RunWorkspaceArtifactV1): void;
  findArtifactBySourceEvent(taskId: string, runId: string, sourceEventId: string): RunWorkspaceArtifactV1 | undefined;
  listArtifacts(taskId: string, runId: string): readonly RunWorkspaceArtifactV1[];
  appendCheckpoint(checkpoint: RunCheckpointV1): void;
  findCheckpoint(checkpointId: string): RunCheckpointV1 | undefined;
  listCheckpoints(taskId: string, runId: string): readonly RunCheckpointV1[];
  close?(): void;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_REFERENCE = /^artifact:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertAttempt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('attempt 必须是大于零的安全整数');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function copyArtifact(artifact: RunWorkspaceArtifactV1): RunWorkspaceArtifactV1 {
  return { ...artifact };
}

function copyCheckpoint(checkpoint: RunCheckpointV1): RunCheckpointV1 {
  return { ...checkpoint };
}

function localTaskReference(taskId: string, nodeId: string): string {
  return `local://task/${taskId}/${nodeId}`;
}

function isAllowedReference(reference: string, taskId: string, nodeId: string): boolean {
  return reference === localTaskReference(taskId, nodeId) || ARTIFACT_REFERENCE.test(reference);
}

function checkpointId(taskId: string, runId: string, attempt: number): string {
  return `checkpoint:${taskId}:${runId}:${attempt}`;
}

function sourceEventKey(taskId: string, runId: string, sourceEventId: string): string {
  return `${taskId}:${runId}:${sourceEventId}`;
}

function artifactLedgerId(taskId: string, runId: string, sourceEventId: string): string {
  return `artifact-ledger:${digest(sourceEventKey(taskId, runId, sourceEventId))}`;
}

function canResume(status: TaskRunStatus, hasRecoverableRequest: boolean): boolean {
  return hasRecoverableRequest && (status === 'blocked' || status === 'failed');
}

/**
 * 将任务事件投影为受控产出引用，并将已保存任务快照投影为不可重放检查点。
 * 不识别的事件、失败工具结果、未知 URI scheme 与含路径的 artifact event 都不会进入账本。
 */
export class RunWorkspaceLedger {
  constructor(private readonly store: RunWorkspaceLedgerStore) {}

  recordTaskEvent(event: TaskEvent): RunWorkspaceArtifactV1 | undefined {
    assertIdentifier(event.eventId, 'eventId');
    assertIdentifier(event.taskId, 'taskId');
    assertIdentifier(event.runId, 'runId');
    assertEpoch(event.at, 'at');
    const existing = this.store.findArtifactBySourceEvent(event.taskId, event.runId, event.eventId);
    if (existing) return copyArtifact(existing);

    if (event.type === 'tool.result') {
      if (event.status !== 'ok' || !isAllowedReference(event.outputRef, event.taskId, event.callId)) return undefined;
      const artifact: RunWorkspaceArtifactV1 = {
        schemaVersion: RUN_WORKSPACE_LEDGER_SCHEMA_VERSION,
        artifactLedgerId: artifactLedgerId(event.taskId, event.runId, event.eventId),
        sourceEventId: event.eventId,
        taskId: event.taskId,
        runId: event.runId,
        nodeId: event.callId,
        reference: event.outputRef,
        referenceDigest: digest(event.outputRef),
        kind: 'tool-output',
        status: 'available',
        at: event.at,
        containsSensitiveContent: false,
        canReplaySideEffects: false,
      };
      this.store.appendArtifact(artifact);
      return copyArtifact(artifact);
    }

    if (event.type === 'artifact.created') {
      assertIdentifier(event.artifactId, 'artifactId');
      const reference = `artifact://${event.artifactId}`;
      const artifact: RunWorkspaceArtifactV1 = {
        schemaVersion: RUN_WORKSPACE_LEDGER_SCHEMA_VERSION,
        artifactLedgerId: artifactLedgerId(event.taskId, event.runId, event.eventId),
        sourceEventId: event.eventId,
        taskId: event.taskId,
        runId: event.runId,
        nodeId: event.artifactId,
        reference,
        referenceDigest: digest(reference),
        kind: 'declared-artifact',
        status: 'available',
        at: event.at,
        containsSensitiveContent: false,
        canReplaySideEffects: false,
      };
      this.store.appendArtifact(artifact);
      return copyArtifact(artifact);
    }

    return undefined;
  }

  recordCheckpoint(snapshot: LocalTaskSnapshot, hasRecoverableRequest: boolean): RunCheckpointV1 {
    assertIdentifier(snapshot.taskId, 'taskId');
    assertIdentifier(snapshot.runId, 'runId');
    assertAttempt(snapshot.attempt);
    assertEpoch(snapshot.updatedAt, 'updatedAt');
    const id = checkpointId(snapshot.taskId, snapshot.runId, snapshot.attempt);
    const existing = this.store.findCheckpoint(id);
    if (existing) return copyCheckpoint(existing);
    const artifacts = this.store.listArtifacts(snapshot.taskId, snapshot.runId);
    const checkpoint: RunCheckpointV1 = {
      schemaVersion: RUN_WORKSPACE_LEDGER_SCHEMA_VERSION,
      checkpointId: id,
      taskId: snapshot.taskId,
      runId: snapshot.runId,
      attempt: snapshot.attempt,
      status: snapshot.status,
      nodeOutcomeDigest: digest(JSON.stringify(Object.entries(snapshot.nodeOutcomes).sort(([left], [right]) => left.localeCompare(right)))),
      artifactManifestDigest: digest(JSON.stringify(artifacts.map((artifact) => ({ id: artifact.artifactLedgerId, referenceDigest: artifact.referenceDigest })))),
      artifactCount: artifacts.length,
      createdAt: snapshot.updatedAt,
      canResume: canResume(snapshot.status, hasRecoverableRequest),
      canReplaySideEffects: false,
    };
    this.store.appendCheckpoint(checkpoint);
    return copyCheckpoint(checkpoint);
  }

  listArtifacts(taskId: string, runId: string): readonly RunWorkspaceArtifactV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return this.store.listArtifacts(taskId, runId).map(copyArtifact);
  }

  listCheckpoints(taskId: string, runId: string): readonly RunCheckpointV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return this.store.listCheckpoints(taskId, runId).map(copyCheckpoint);
  }
}

export class InMemoryRunWorkspaceLedgerStore implements RunWorkspaceLedgerStore {
  private readonly artifacts = new Map<string, RunWorkspaceArtifactV1>();
  private readonly artifactsBySource = new Map<string, string>();
  private readonly checkpoints = new Map<string, RunCheckpointV1>();

  appendArtifact(artifact: RunWorkspaceArtifactV1): void {
    assertIdentifier(artifact.artifactLedgerId, 'artifactLedgerId');
    assertIdentifier(artifact.sourceEventId, 'sourceEventId');
    const key = sourceEventKey(artifact.taskId, artifact.runId, artifact.sourceEventId);
    if (this.artifacts.has(artifact.artifactLedgerId) || this.artifactsBySource.has(key)) {
      throw new Error(`artifact source event ${artifact.sourceEventId} 已存在于当前 task/run；账本不可覆盖`);
    }
    this.artifacts.set(artifact.artifactLedgerId, copyArtifact(artifact));
    this.artifactsBySource.set(key, artifact.artifactLedgerId);
  }

  findArtifactBySourceEvent(taskId: string, runId: string, sourceEventId: string): RunWorkspaceArtifactV1 | undefined {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    assertIdentifier(sourceEventId, 'sourceEventId');
    const id = this.artifactsBySource.get(sourceEventKey(taskId, runId, sourceEventId));
    const artifact = id ? this.artifacts.get(id) : undefined;
    return artifact ? copyArtifact(artifact) : undefined;
  }

  listArtifacts(taskId: string, runId: string): readonly RunWorkspaceArtifactV1[] {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.taskId === taskId && artifact.runId === runId)
      .sort((left, right) => left.at - right.at || left.artifactLedgerId.localeCompare(right.artifactLedgerId))
      .map(copyArtifact);
  }

  appendCheckpoint(checkpoint: RunCheckpointV1): void {
    assertIdentifier(checkpoint.checkpointId, 'checkpointId');
    if (this.checkpoints.has(checkpoint.checkpointId)) throw new Error(`checkpoint ${checkpoint.checkpointId} 已存在；账本不可覆盖`);
    this.checkpoints.set(checkpoint.checkpointId, copyCheckpoint(checkpoint));
  }

  findCheckpoint(id: string): RunCheckpointV1 | undefined {
    assertIdentifier(id, 'checkpointId');
    const checkpoint = this.checkpoints.get(id);
    return checkpoint ? copyCheckpoint(checkpoint) : undefined;
  }

  listCheckpoints(taskId: string, runId: string): readonly RunCheckpointV1[] {
    return [...this.checkpoints.values()]
      .filter((checkpoint) => checkpoint.taskId === taskId && checkpoint.runId === runId)
      .sort((left, right) => left.attempt - right.attempt || left.checkpointId.localeCompare(right.checkpointId))
      .map(copyCheckpoint);
  }
}

/** SQLite WAL append-only 工作区账本；所有可持久化字段均为受控 metadata。 */
export class SqliteRunWorkspaceLedgerStore implements RunWorkspaceLedgerStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_workspace_artifacts (
        artifact_ledger_id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        artifact_json TEXT NOT NULL,
        UNIQUE(task_id, run_id, source_event_id)
      );
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        checkpoint_json TEXT NOT NULL,
        UNIQUE(task_id, run_id, attempt)
      );
    `);
  }

  appendArtifact(artifact: RunWorkspaceArtifactV1): void {
    this.db.prepare(`
      INSERT INTO run_workspace_artifacts (artifact_ledger_id, source_event_id, task_id, run_id, at, artifact_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(artifact.artifactLedgerId, artifact.sourceEventId, artifact.taskId, artifact.runId, artifact.at, JSON.stringify(copyArtifact(artifact)));
  }

  findArtifactBySourceEvent(taskId: string, runId: string, sourceEventId: string): RunWorkspaceArtifactV1 | undefined {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    assertIdentifier(sourceEventId, 'sourceEventId');
    const row = this.db.prepare('SELECT artifact_json FROM run_workspace_artifacts WHERE task_id = ? AND run_id = ? AND source_event_id = ?').get(taskId, runId, sourceEventId) as { artifact_json: string } | undefined;
    return row ? copyArtifact(JSON.parse(row.artifact_json) as RunWorkspaceArtifactV1) : undefined;
  }

  listArtifacts(taskId: string, runId: string): readonly RunWorkspaceArtifactV1[] {
    const rows = this.db.prepare(`
      SELECT artifact_json FROM run_workspace_artifacts WHERE task_id = ? AND run_id = ? ORDER BY at ASC, artifact_ledger_id ASC
    `).all(taskId, runId) as unknown as readonly { artifact_json: string }[];
    return rows.map((row) => copyArtifact(JSON.parse(row.artifact_json) as RunWorkspaceArtifactV1));
  }

  appendCheckpoint(checkpoint: RunCheckpointV1): void {
    this.db.prepare(`
      INSERT INTO run_checkpoints (checkpoint_id, task_id, run_id, attempt, created_at, checkpoint_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(checkpoint.checkpointId, checkpoint.taskId, checkpoint.runId, checkpoint.attempt, checkpoint.createdAt, JSON.stringify(copyCheckpoint(checkpoint)));
  }

  findCheckpoint(id: string): RunCheckpointV1 | undefined {
    assertIdentifier(id, 'checkpointId');
    const row = this.db.prepare('SELECT checkpoint_json FROM run_checkpoints WHERE checkpoint_id = ?').get(id) as { checkpoint_json: string } | undefined;
    return row ? copyCheckpoint(JSON.parse(row.checkpoint_json) as RunCheckpointV1) : undefined;
  }

  listCheckpoints(taskId: string, runId: string): readonly RunCheckpointV1[] {
    const rows = this.db.prepare(`
      SELECT checkpoint_json FROM run_checkpoints WHERE task_id = ? AND run_id = ? ORDER BY attempt ASC, checkpoint_id ASC
    `).all(taskId, runId) as unknown as readonly { checkpoint_json: string }[];
    return rows.map((row) => copyCheckpoint(JSON.parse(row.checkpoint_json) as RunCheckpointV1));
  }

  close(): void {
    this.db.close();
  }
}
