import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TaskEvent } from '@awo/protocol';

export const RUN_TRAJECTORY_SCHEMA_VERSION = 1 as const;

export type RunTrajectorySource = 'task-runtime' | 'gateway.intent' | 'approval';
export type RunTrajectoryAttribute = string | number | boolean;

/**
 * 可审计的 run metadata 投影；从设计上排除目标正文、prompt、reasoning、credential、Skill 规则、tool args/result。
 * trajectory 可帮助检索和解释状态，但不能被当作副作用重放指令。
 */
export interface RunTrajectoryEventV1 {
  schemaVersion: typeof RUN_TRAJECTORY_SCHEMA_VERSION;
  trajectoryEventId: string;
  sourceEventId: string;
  taskId: string;
  runId: string;
  sequence: number;
  at: number;
  source: RunTrajectorySource;
  kind: TaskEvent['type'];
  attributes: Readonly<Record<string, RunTrajectoryAttribute>>;
  canReplaySideEffects: false;
}

export interface RunTrajectoryStore {
  append(event: RunTrajectoryEventV1): void;
  findBySourceEvent(sourceEventId: string): RunTrajectoryEventV1 | undefined;
  list(taskId: string, runId: string): readonly RunTrajectoryEventV1[];
  close?(): void;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function copyEvent(event: RunTrajectoryEventV1): RunTrajectoryEventV1 {
  return { ...event, attributes: { ...event.attributes } };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function metadataForTaskEvent(event: TaskEvent): Readonly<Record<string, RunTrajectoryAttribute>> {
  switch (event.type) {
    case 'task.created':
      return { goalDigest: digest(event.goal) };
    case 'agent.profile.selected':
      return { profileId: event.profileId };
    case 'plan.proposed':
      return {
        stepCount: event.steps.length,
        lowRiskSteps: event.steps.filter((step) => (step.risk ?? 'low') === 'low').length,
        mediumRiskSteps: event.steps.filter((step) => step.risk === 'medium').length,
        highRiskSteps: event.steps.filter((step) => step.risk === 'high').length,
      };
    case 'approval.required':
      return { actionId: event.actionId, capability: event.capability, risk: event.risk };
    case 'approval.resolved':
      return { actionId: event.actionId, decision: event.decision, resolvedBy: event.resolvedBy };
    case 'tool.called':
      return { callId: event.callId, toolName: event.tool.name, capability: event.tool.capability, risk: event.tool.risk, inputHash: event.inputHash };
    case 'tool.result':
      return { callId: event.callId, status: event.status, blocked: event.blocked ?? false, errorCode: event.errorCode ?? 'none' };
    case 'artifact.created':
      return { artifactId: event.artifactId, mime: event.mime };
    case 'task.completed':
      return { completed: true };
    case 'task.failed':
      return { code: event.code };
    case 'context.compacted':
      return {
        retainedCount: event.retainedItemIds.length,
        compactedCount: event.compactedItemIds.length,
        estimatedTokensBefore: event.estimatedTokensBefore,
        estimatedTokensAfter: event.estimatedTokensAfter,
      };
    case 'execution.blocked':
      return { callId: event.callId, code: event.code };
  }
}

/** 将原始领域事件投影为仅 metadata 的统一轨迹；同一 source event 可安全幂等重放。 */
export class RunTrajectoryLedger {
  constructor(private readonly store: RunTrajectoryStore) {}

  recordTaskEvent(event: TaskEvent, source: RunTrajectorySource = 'task-runtime'): RunTrajectoryEventV1 {
    assertIdentifier(event.eventId, 'eventId');
    assertIdentifier(event.taskId, 'taskId');
    assertIdentifier(event.runId, 'runId');
    assertEpoch(event.at, 'at');
    const existing = this.store.findBySourceEvent(event.eventId);
    if (existing) return existing;
    const sequence = this.store.list(event.taskId, event.runId).length + 1;
    const trajectory: RunTrajectoryEventV1 = {
      schemaVersion: RUN_TRAJECTORY_SCHEMA_VERSION,
      trajectoryEventId: `trajectory:${event.eventId}`,
      sourceEventId: event.eventId,
      taskId: event.taskId,
      runId: event.runId,
      sequence,
      at: event.at,
      source,
      kind: event.type,
      attributes: metadataForTaskEvent(event),
      canReplaySideEffects: false,
    };
    this.store.append(trajectory);
    return copyEvent(trajectory);
  }

  list(taskId: string, runId: string): readonly RunTrajectoryEventV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return this.store.list(taskId, runId).map(copyEvent);
  }
}

export class InMemoryRunTrajectoryStore implements RunTrajectoryStore {
  private readonly events = new Map<string, RunTrajectoryEventV1>();
  private readonly sourceEventIds = new Map<string, string>();

  append(event: RunTrajectoryEventV1): void {
    assertIdentifier(event.trajectoryEventId, 'trajectoryEventId');
    assertIdentifier(event.sourceEventId, 'sourceEventId');
    assertIdentifier(event.taskId, 'taskId');
    assertIdentifier(event.runId, 'runId');
    if (this.events.has(event.trajectoryEventId) || this.sourceEventIds.has(event.sourceEventId)) {
      throw new Error(`trajectory source event ${event.sourceEventId} 已存在；审计轨迹不可覆盖`);
    }
    this.events.set(event.trajectoryEventId, copyEvent(event));
    this.sourceEventIds.set(event.sourceEventId, event.trajectoryEventId);
  }

  findBySourceEvent(sourceEventId: string): RunTrajectoryEventV1 | undefined {
    assertIdentifier(sourceEventId, 'sourceEventId');
    const id = this.sourceEventIds.get(sourceEventId);
    const event = id ? this.events.get(id) : undefined;
    return event ? copyEvent(event) : undefined;
  }

  list(taskId: string, runId: string): readonly RunTrajectoryEventV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return [...this.events.values()]
      .filter((event) => event.taskId === taskId && event.runId === runId)
      .sort((left, right) => left.sequence - right.sequence || left.trajectoryEventId.localeCompare(right.trajectoryEventId))
      .map(copyEvent);
  }
}

/** SQLite WAL append-only trajectory 账本；只保存脱敏 metadata 投影。 */
export class SqliteRunTrajectoryStore implements RunTrajectoryStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_trajectory_events (
        trajectory_event_id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        at INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        UNIQUE(task_id, run_id, sequence)
      );
    `);
  }

  append(event: RunTrajectoryEventV1): void {
    this.db.prepare(`
      INSERT INTO run_trajectory_events (trajectory_event_id, source_event_id, task_id, run_id, sequence, at, event_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.trajectoryEventId, event.sourceEventId, event.taskId, event.runId, event.sequence, event.at, JSON.stringify(copyEvent(event)));
  }

  findBySourceEvent(sourceEventId: string): RunTrajectoryEventV1 | undefined {
    assertIdentifier(sourceEventId, 'sourceEventId');
    const row = this.db.prepare('SELECT event_json FROM run_trajectory_events WHERE source_event_id = ?').get(sourceEventId) as { event_json: string } | undefined;
    return row ? copyEvent(JSON.parse(row.event_json) as RunTrajectoryEventV1) : undefined;
  }

  list(taskId: string, runId: string): readonly RunTrajectoryEventV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    const rows = this.db.prepare(`
      SELECT event_json FROM run_trajectory_events WHERE task_id = ? AND run_id = ? ORDER BY sequence ASC, trajectory_event_id ASC
    `).all(taskId, runId) as unknown as readonly { event_json: string }[];
    return rows.map((row) => copyEvent(JSON.parse(row.event_json) as RunTrajectoryEventV1));
  }

  close(): void {
    this.db.close();
  }
}
