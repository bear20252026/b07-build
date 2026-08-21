import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ApiUsageTokenStatus = 'not-reported';

export interface ApiUsageReceiptV1 {
  schemaVersion: 1;
  usageId: string;
  recordedAt: number;
  providerId: string;
  profileId: string;
  profileRevision: number;
  model: string;
  dataBoundary: 'remote-allowed';
  latencyMs: number;
  outputCharacters: number;
  tokenStatus: ApiUsageTokenStatus;
  canReadSecret: false;
  containsPrompt: false;
  containsOutput: false;
  containsEndpoint: false;
}

export interface RecordCompletedApiUsage {
  providerId: string;
  profileId: string;
  profileRevision: number;
  model: string;
  dataBoundary: 'remote-allowed';
  latencyMs: number;
  outputCharacters: number;
  recordedAt: number;
}

export interface ApiUsageModelSummary {
  providerId: string;
  model: string;
  callCount: number;
  totalLatencyMs: number;
  totalOutputCharacters: number;
  tokenStatus: ApiUsageTokenStatus;
}

export interface ApiUsageSummary {
  schemaVersion: 1;
  generatedAt: number;
  totalCalls: number;
  totalLatencyMs: number;
  totalOutputCharacters: number;
  tokenStatus: ApiUsageTokenStatus;
  latestRecordedAt?: number;
  models: readonly ApiUsageModelSummary[];
}

export interface ApiUsageStore {
  append(receipt: ApiUsageReceiptV1): void;
  list(limit: number): readonly ApiUsageReceiptV1[];
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(value)) throw new Error(`${name} 必须是安全标识符`);
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function copy(receipt: ApiUsageReceiptV1): ApiUsageReceiptV1 {
  return { ...receipt };
}

function validate(receipt: ApiUsageReceiptV1): void {
  assertIdentifier(receipt.usageId, 'usageId');
  assertIdentifier(receipt.providerId, 'providerId');
  assertIdentifier(receipt.profileId, 'profileId');
  assertIdentifier(receipt.model, 'model');
  assertNonNegative(receipt.recordedAt, 'recordedAt');
  assertNonNegative(receipt.profileRevision, 'profileRevision');
  assertNonNegative(receipt.latencyMs, 'latencyMs');
  assertNonNegative(receipt.outputCharacters, 'outputCharacters');
  if (receipt.schemaVersion !== 1 || receipt.dataBoundary !== 'remote-allowed' || receipt.tokenStatus !== 'not-reported') throw new Error('API 用量收据字段无效');
  if (receipt.canReadSecret || receipt.containsPrompt || receipt.containsOutput || receipt.containsEndpoint) throw new Error('API 用量收据不得包含秘密、提示词、输出或端点');
}

/** Gateway 已完成推理的本地、追加式计量账本；没有 prompt、output、digest、key、URL 或账单估算。 */
export class ApiUsageLedger {
  constructor(private readonly store: ApiUsageStore, private readonly makeId: () => string = randomUUID) {}

  recordCompleted(input: RecordCompletedApiUsage): ApiUsageReceiptV1 {
    assertIdentifier(input.providerId, 'providerId');
    assertIdentifier(input.profileId, 'profileId');
    assertIdentifier(input.model, 'model');
    assertNonNegative(input.profileRevision, 'profileRevision');
    assertNonNegative(input.latencyMs, 'latencyMs');
    assertNonNegative(input.outputCharacters, 'outputCharacters');
    assertNonNegative(input.recordedAt, 'recordedAt');
    const receipt: ApiUsageReceiptV1 = {
      schemaVersion: 1,
      usageId: `usage:${this.makeId()}`,
      recordedAt: input.recordedAt,
      providerId: input.providerId,
      profileId: input.profileId,
      profileRevision: input.profileRevision,
      model: input.model,
      dataBoundary: input.dataBoundary,
      latencyMs: input.latencyMs,
      outputCharacters: input.outputCharacters,
      tokenStatus: 'not-reported',
      canReadSecret: false,
      containsPrompt: false,
      containsOutput: false,
      containsEndpoint: false,
    };
    validate(receipt);
    this.store.append(receipt);
    return copy(receipt);
  }

  recent(limit = 100): readonly ApiUsageReceiptV1[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('limit 必须是 1-500 的整数');
    return this.store.list(limit).map(copy);
  }

  summary(generatedAt: number, limit = 500): ApiUsageSummary {
    assertNonNegative(generatedAt, 'generatedAt');
    const receipts = this.recent(limit);
    const models = new Map<string, ApiUsageModelSummary>();
    for (const receipt of receipts) {
      const key = `${receipt.providerId}\u0000${receipt.model}`;
      const current = models.get(key) ?? { providerId: receipt.providerId, model: receipt.model, callCount: 0, totalLatencyMs: 0, totalOutputCharacters: 0, tokenStatus: 'not-reported' as const };
      current.callCount += 1;
      current.totalLatencyMs += receipt.latencyMs;
      current.totalOutputCharacters += receipt.outputCharacters;
      models.set(key, current);
    }
    return {
      schemaVersion: 1,
      generatedAt,
      totalCalls: receipts.length,
      totalLatencyMs: receipts.reduce((sum, receipt) => sum + receipt.latencyMs, 0),
      totalOutputCharacters: receipts.reduce((sum, receipt) => sum + receipt.outputCharacters, 0),
      tokenStatus: 'not-reported',
      latestRecordedAt: receipts[0]?.recordedAt,
      models: [...models.values()].sort((left, right) => right.callCount - left.callCount || left.providerId.localeCompare(right.providerId) || left.model.localeCompare(right.model)),
    };
  }
}

export class InMemoryApiUsageStore implements ApiUsageStore {
  private readonly receipts: ApiUsageReceiptV1[] = [];

  append(receipt: ApiUsageReceiptV1): void {
    validate(receipt);
    if (this.receipts.some((item) => item.usageId === receipt.usageId)) throw new Error('usageId 必须唯一');
    this.receipts.push(copy(receipt));
  }

  list(limit: number): readonly ApiUsageReceiptV1[] {
    return [...this.receipts].sort((left, right) => right.recordedAt - left.recordedAt || right.usageId.localeCompare(left.usageId)).slice(0, limit).map(copy);
  }
}

interface ApiUsageRow {
  usage_id: string; recorded_at: number; provider_id: string; profile_id: string; profile_revision: number; model: string;
  data_boundary: 'remote-allowed'; latency_ms: number; output_characters: number; token_status: ApiUsageTokenStatus;
}

export class SqliteApiUsageStore implements ApiUsageStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS api_usage_receipts (
      usage_id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL, provider_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      profile_revision INTEGER NOT NULL, model TEXT NOT NULL, data_boundary TEXT NOT NULL CHECK(data_boundary = 'remote-allowed'),
      latency_ms INTEGER NOT NULL, output_characters INTEGER NOT NULL, token_status TEXT NOT NULL CHECK(token_status = 'not-reported')
    ); CREATE INDEX IF NOT EXISTS idx_api_usage_receipts_recent ON api_usage_receipts (recorded_at DESC, usage_id DESC);`);
  }

  append(receipt: ApiUsageReceiptV1): void {
    validate(receipt);
    this.db.prepare(`INSERT INTO api_usage_receipts (usage_id, recorded_at, provider_id, profile_id, profile_revision, model, data_boundary, latency_ms, output_characters, token_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(receipt.usageId, receipt.recordedAt, receipt.providerId, receipt.profileId, receipt.profileRevision, receipt.model, receipt.dataBoundary, receipt.latencyMs, receipt.outputCharacters, receipt.tokenStatus);
  }

  list(limit: number): readonly ApiUsageReceiptV1[] {
    const rows = this.db.prepare(`SELECT usage_id, recorded_at, provider_id, profile_id, profile_revision, model, data_boundary, latency_ms, output_characters, token_status
      FROM api_usage_receipts ORDER BY recorded_at DESC, usage_id DESC LIMIT ?`).all(limit) as unknown as readonly ApiUsageRow[];
    return rows.map((row) => ({ schemaVersion: 1, usageId: row.usage_id, recordedAt: row.recorded_at, providerId: row.provider_id, profileId: row.profile_id, profileRevision: row.profile_revision, model: row.model, dataBoundary: row.data_boundary, latencyMs: row.latency_ms, outputCharacters: row.output_characters, tokenStatus: row.token_status, canReadSecret: false, containsPrompt: false, containsOutput: false, containsEndpoint: false }));
  }

  close(): void { this.db.close(); }
}
