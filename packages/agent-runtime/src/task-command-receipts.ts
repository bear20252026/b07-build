import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentProfileId, ExecutionAuthorityMode } from '@awo/protocol';
import type { LocalTaskSnapshot } from './recoverable-task-runtime.js';

export type TaskCommand = 'submit' | 'resume' | 'approve';

/**
 * 一条命令收据与一个 client idempotency key 一一对应。它不是权限凭据，不能替代 CapabilityPolicy
 * 或 ApprovalPort；它只允许网络重试得到同一任务/运行的稳定结果。
 */
export interface TaskCommandReceipt {
  schemaVersion: 1;
  command: TaskCommand;
  idempotencyKey: string;
  fingerprint: string;
  taskId: string;
  runId: string;
  goal: string;
  profileId: AgentProfileId;
  /** 新回执始终记录；旧回执缺省安全回退为 review。 */
  authorityMode?: ExecutionAuthorityMode;
  nodeId?: string;
  acceptedAt: number;
  completedAt?: number;
  snapshot?: LocalTaskSnapshot;
}

export interface TaskCommandReceiptStore {
  get(command: TaskCommand, idempotencyKey: string): TaskCommandReceipt | undefined;
  claim(receipt: TaskCommandReceipt): { kind: 'claimed'; receipt: TaskCommandReceipt } | { kind: 'replayed'; receipt: TaskCommandReceipt };
  complete(command: TaskCommand, idempotencyKey: string, snapshot: LocalTaskSnapshot, at: number): TaskCommandReceipt;
}

function assertSafeKey(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new Error(`${name} 必须是 8-128 位安全幂等标识符`);
  }
}

function copySnapshot(snapshot: LocalTaskSnapshot): LocalTaskSnapshot {
  return structuredClone(snapshot);
}

export function copyTaskCommandReceipt(receipt: TaskCommandReceipt): TaskCommandReceipt {
  return { ...receipt, snapshot: receipt.snapshot ? copySnapshot(receipt.snapshot) : undefined };
}

function validate(receipt: TaskCommandReceipt): void {
  if (receipt.schemaVersion !== 1) throw new Error('只支持 TaskCommandReceipt v1');
  assertSafeKey(receipt.idempotencyKey, 'idempotencyKey');
  assertSafeKey(receipt.taskId, 'taskId');
  assertSafeKey(receipt.runId, 'runId');
  if (!receipt.goal.trim()) throw new Error('receipt goal 不能为空');
  if (!['build', 'plan', 'explore', 'reader'].includes(receipt.profileId)) throw new Error('receipt profileId 无效');
  if (receipt.authorityMode !== undefined && !['plan', 'review', 'automate', 'admin'].includes(receipt.authorityMode)) throw new Error('receipt authorityMode 无效');
  if (!receipt.fingerprint || receipt.fingerprint.length > 128) throw new Error('receipt fingerprint 无效');
  if (!Number.isSafeInteger(receipt.acceptedAt) || receipt.acceptedAt < 0) throw new Error('receipt acceptedAt 无效');
  if (receipt.nodeId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.nodeId)) {
    throw new Error('nodeId 必须是 1-128 位安全节点标识符');
  }
}

export class InMemoryTaskCommandReceiptStore implements TaskCommandReceiptStore {
  private readonly receipts = new Map<string, TaskCommandReceipt>();

  get(command: TaskCommand, idempotencyKey: string): TaskCommandReceipt | undefined {
    const receipt = this.receipts.get(`${command}:${idempotencyKey}`);
    return receipt ? copyTaskCommandReceipt(receipt) : undefined;
  }

  claim(receipt: TaskCommandReceipt): { kind: 'claimed'; receipt: TaskCommandReceipt } | { kind: 'replayed'; receipt: TaskCommandReceipt } {
    validate(receipt);
    const key = `${receipt.command}:${receipt.idempotencyKey}`;
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.fingerprint !== receipt.fingerprint) {
        throw new Error(`幂等键 ${receipt.idempotencyKey} 已用于不同的 ${receipt.command} 请求`);
      }
      return { kind: 'replayed', receipt: copyTaskCommandReceipt(existing) };
    }
    const copy = copyTaskCommandReceipt(receipt);
    this.receipts.set(key, copy);
    return { kind: 'claimed', receipt: copyTaskCommandReceipt(copy) };
  }

  complete(command: TaskCommand, idempotencyKey: string, snapshot: LocalTaskSnapshot, at: number): TaskCommandReceipt {
    const key = `${command}:${idempotencyKey}`;
    const existing = this.receipts.get(key);
    if (!existing) throw new Error(`不存在待完成的 ${command} 收据`);
    if (!Number.isSafeInteger(at) || at < existing.acceptedAt) throw new Error('completedAt 无效');
    const next: TaskCommandReceipt = { ...existing, snapshot: copySnapshot(snapshot), completedAt: at };
    this.receipts.set(key, next);
    return copyTaskCommandReceipt(next);
  }
}

interface ReceiptRow { receipt_json: string; }

/** SQLite WAL + append-only revision store for gateway command receipts. */
export class SqliteTaskCommandReceiptStore implements TaskCommandReceiptStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_command_receipts (
        command TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY(command, idempotency_key, revision)
      );
      CREATE INDEX IF NOT EXISTS task_command_receipts_lookup_idx
        ON task_command_receipts(command, idempotency_key, revision DESC);
    `);
  }

  get(command: TaskCommand, idempotencyKey: string): TaskCommandReceipt | undefined {
    const row = this.db.prepare(`
      SELECT receipt_json FROM task_command_receipts
      WHERE command = ? AND idempotency_key = ?
      ORDER BY revision DESC LIMIT 1
    `).get(command, idempotencyKey) as ReceiptRow | undefined;
    return row ? copyTaskCommandReceipt(JSON.parse(row.receipt_json) as TaskCommandReceipt) : undefined;
  }

  claim(receipt: TaskCommandReceipt): { kind: 'claimed'; receipt: TaskCommandReceipt } | { kind: 'replayed'; receipt: TaskCommandReceipt } {
    validate(receipt);
    const existing = this.get(receipt.command, receipt.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== receipt.fingerprint) {
        throw new Error(`幂等键 ${receipt.idempotencyKey} 已用于不同的 ${receipt.command} 请求`);
      }
      return { kind: 'replayed', receipt: existing };
    }
    const copy = copyTaskCommandReceipt(receipt);
    this.db.prepare(`
      INSERT INTO task_command_receipts(command, idempotency_key, revision, recorded_at_ms, receipt_json)
      VALUES (?, ?, 1, ?, ?)
    `).run(copy.command, copy.idempotencyKey, copy.acceptedAt, JSON.stringify(copy));
    return { kind: 'claimed', receipt: copyTaskCommandReceipt(copy) };
  }

  complete(command: TaskCommand, idempotencyKey: string, snapshot: LocalTaskSnapshot, at: number): TaskCommandReceipt {
    const current = this.get(command, idempotencyKey);
    if (!current) throw new Error(`不存在待完成的 ${command} 收据`);
    if (!Number.isSafeInteger(at) || at < current.acceptedAt) throw new Error('completedAt 无效');
    const next: TaskCommandReceipt = { ...current, snapshot: copySnapshot(snapshot), completedAt: at };
    const revision = this.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision FROM task_command_receipts
      WHERE command = ? AND idempotency_key = ?
    `).get(command, idempotencyKey) as { revision: number };
    this.db.prepare(`
      INSERT INTO task_command_receipts(command, idempotency_key, revision, recorded_at_ms, receipt_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(command, idempotencyKey, revision.revision + 1, at, JSON.stringify(next));
    return copyTaskCommandReceipt(next);
  }

  history(command: TaskCommand, idempotencyKey: string): readonly TaskCommandReceipt[] {
    const rows = this.db.prepare(`
      SELECT receipt_json FROM task_command_receipts
      WHERE command = ? AND idempotency_key = ? ORDER BY revision ASC
    `).all(command, idempotencyKey) as unknown as ReceiptRow[];
    return rows.map((row) => copyTaskCommandReceipt(JSON.parse(row.receipt_json) as TaskCommandReceipt));
  }

  close(): void {
    this.db.close();
  }
}
