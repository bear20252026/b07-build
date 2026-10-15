// 一个文件=一种作用：外部会话索引账本（内存与 SQLite 两实现）。
//
// 设计借鉴（非源码移植）：「先写库（占位）后索引」的竞态守卫 + 稳定身份唯一约束，
// 借鉴自一个 AGPL-3.0-or-later 的第三方项目（项目名与许可见 THIRD-PARTY-NOTICES.md
// 「语义借用（非源码移植）」小节）。本文件为 b07 独立实现，未复制任何上游代码。
//
// 竞态保证：
//   - `session_id` 是主键（会话主键，文件级稳定身份）→ 同一会话永远只有一条记录；
//   - `session_key` 加唯一索引（稳定身份，含内容摘要）→ 同一内容不会被登记为两条；
//   - `claim()` 以 INSERT OR IGNORE 占位：读内容之前先写库，其他发现者立刻能看到该会话已登记；
//   - `commit()` 以 upsert 覆盖同主键记录，内容更新是「覆盖」而非「新增」；
//   - `rollback()` 只在占位行仍与本次观测匹配时删除，绝不误删已提交记录。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ExternalSessionClaim,
  ExternalSessionIndexCursor,
  ExternalSessionIndexRecord,
  ExternalSessionIndexStore,
  NormalizedExternalSession,
} from './external-session-index-types.js';

/** 复制一条索引记录（防御性，避免调用方改到账本内部状态）。 */
function copyRecord(record: ExternalSessionIndexRecord): ExternalSessionIndexRecord {
  return {
    ...record,
    ...(record.session ? { session: copySession(record.session) } : {}),
  };
}

function copySession(session: NormalizedExternalSession): NormalizedExternalSession {
  return { ...session, messages: session.messages.map((message) => ({ ...message })) };
}

function copyCursor(cursor: ExternalSessionIndexCursor): ExternalSessionIndexCursor {
  return { ...cursor };
}

function sortRecords(records: readonly ExternalSessionIndexRecord[]): ExternalSessionIndexRecord[] {
  return [...records].sort(
    (left, right) => left.sourceId.localeCompare(right.sourceId) || left.relativePath.localeCompare(right.relativePath),
  );
}

/** 内存账本：测试与轻量场景使用，语义与 SQLite 实现一致。 */
export class InMemoryExternalSessionIndexStore implements ExternalSessionIndexStore {
  private readonly records = new Map<string, ExternalSessionIndexRecord>();
  private readonly cursors = new Map<string, ExternalSessionIndexCursor>();

  claim(claim: ExternalSessionClaim): boolean {
    if (this.records.has(claim.sessionId)) return false;
    this.records.set(claim.sessionId, {
      sessionId: claim.sessionId,
      // 占位期间 session_key 暂用会话主键占位（唯一），commit 时替换为真实内容身份。
      sessionKey: claim.sessionId,
      sourceId: claim.sourceId,
      relativePath: claim.relativePath,
      filePath: claim.filePath,
      status: 'indexing',
      messageCount: 0,
      observedSizeBytes: claim.observedSizeBytes,
      observedModifiedAtMs: claim.observedModifiedAtMs,
      indexedAtMs: claim.at,
    });
    return true;
  }

  load(sessionId: string): ExternalSessionIndexRecord | undefined {
    const record = this.records.get(sessionId);
    return record ? copyRecord(record) : undefined;
  }

  commit(record: ExternalSessionIndexRecord): void {
    this.records.set(record.sessionId, copyRecord(record));
  }

  rollback(sessionId: string, observed: { sizeBytes: number; modifiedAtMs: number }): void {
    const current = this.records.get(sessionId);
    if (!current || current.status !== 'indexing') return;
    if (current.observedSizeBytes !== observed.sizeBytes || current.observedModifiedAtMs !== observed.modifiedAtMs) return;
    this.records.delete(sessionId);
  }

  list(): readonly ExternalSessionIndexRecord[] {
    return sortRecords([...this.records.values()].map(copyRecord));
  }

  loadCursor(sourceId: string): ExternalSessionIndexCursor | undefined {
    const cursor = this.cursors.get(sourceId);
    return cursor ? copyCursor(cursor) : undefined;
  }

  saveCursor(cursor: ExternalSessionIndexCursor): void {
    this.cursors.set(cursor.sourceId, copyCursor(cursor));
  }
}

interface RecordRow {
  session_id: string;
  session_key: string;
  source_id: string;
  relative_path: string;
  file_path: string;
  status: string;
  content_digest: string | null;
  external_session_id: string | null;
  title: string | null;
  message_count: number;
  observed_size_bytes: number;
  observed_modified_at_ms: number;
  indexed_at_ms: number;
  session_json: string | null;
}

interface CursorRow {
  source_id: string;
  watermark_ms: number;
  last_processed_count: number;
  updated_at_ms: number;
}

function rowToRecord(row: RecordRow): ExternalSessionIndexRecord {
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    sourceId: row.source_id,
    relativePath: row.relative_path,
    filePath: row.file_path,
    status: row.status === 'indexed' ? 'indexed' : 'indexing',
    ...(row.content_digest !== null ? { contentDigest: row.content_digest } : {}),
    ...(row.external_session_id !== null ? { externalSessionId: row.external_session_id } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    messageCount: row.message_count,
    observedSizeBytes: row.observed_size_bytes,
    observedModifiedAtMs: row.observed_modified_at_ms,
    indexedAtMs: row.indexed_at_ms,
    ...(row.session_json !== null ? { session: JSON.parse(row.session_json) as NormalizedExternalSession } : {}),
  };
}

/** SQLite 账本：WAL、单写多读；记录与游标持久化，供跨进程增量续跑。 */
export class SqliteExternalSessionIndexStore implements ExternalSessionIndexStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS external_session_index (
        session_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL,
        content_digest TEXT,
        external_session_id TEXT,
        title TEXT,
        message_count INTEGER NOT NULL,
        observed_size_bytes INTEGER NOT NULL,
        observed_modified_at_ms REAL NOT NULL,
        indexed_at_ms INTEGER NOT NULL,
        session_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS external_session_index_content_idx
        ON external_session_index(session_key);
      CREATE INDEX IF NOT EXISTS external_session_index_source_idx
        ON external_session_index(source_id, relative_path);
      CREATE TABLE IF NOT EXISTS external_session_index_cursor (
        source_id TEXT PRIMARY KEY,
        watermark_ms REAL NOT NULL,
        last_processed_count INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  claim(claim: ExternalSessionClaim): boolean {
    const result = this.db
      .prepare(`
        INSERT INTO external_session_index (
          session_id, session_key, source_id, relative_path, file_path, status,
          message_count, observed_size_bytes, observed_modified_at_ms, indexed_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'indexing', 0, ?, ?, ?)
        ON CONFLICT(session_id) DO NOTHING
      `)
      .run(
        claim.sessionId,
        claim.sessionId,
        claim.sourceId,
        claim.relativePath,
        claim.filePath,
        claim.observedSizeBytes,
        claim.observedModifiedAtMs,
        claim.at,
      );
    return Number(result.changes) > 0;
  }

  load(sessionId: string): ExternalSessionIndexRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM external_session_index WHERE session_id = ?`)
      .get(sessionId) as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  commit(record: ExternalSessionIndexRecord): void {
    this.db
      .prepare(`
        INSERT INTO external_session_index (
          session_id, session_key, source_id, relative_path, file_path, status,
          content_digest, external_session_id, title, message_count,
          observed_size_bytes, observed_modified_at_ms, indexed_at_ms, session_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          session_key = excluded.session_key,
          source_id = excluded.source_id,
          relative_path = excluded.relative_path,
          file_path = excluded.file_path,
          status = excluded.status,
          content_digest = excluded.content_digest,
          external_session_id = excluded.external_session_id,
          title = excluded.title,
          message_count = excluded.message_count,
          observed_size_bytes = excluded.observed_size_bytes,
          observed_modified_at_ms = excluded.observed_modified_at_ms,
          indexed_at_ms = excluded.indexed_at_ms,
          session_json = excluded.session_json
      `)
      .run(
        record.sessionId,
        record.sessionKey,
        record.sourceId,
        record.relativePath,
        record.filePath,
        record.status,
        record.contentDigest ?? null,
        record.externalSessionId ?? null,
        record.title ?? null,
        record.messageCount,
        record.observedSizeBytes,
        record.observedModifiedAtMs,
        record.indexedAtMs,
        record.session ? JSON.stringify(record.session) : null,
      );
  }

  rollback(sessionId: string, observed: { sizeBytes: number; modifiedAtMs: number }): void {
    this.db
      .prepare(`
        DELETE FROM external_session_index
        WHERE session_id = ? AND status = 'indexing'
          AND observed_size_bytes = ? AND observed_modified_at_ms = ?
      `)
      .run(sessionId, observed.sizeBytes, observed.modifiedAtMs);
  }

  list(): readonly ExternalSessionIndexRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM external_session_index ORDER BY source_id ASC, relative_path ASC`)
      .all() as unknown as readonly RecordRow[];
    return rows.map(rowToRecord);
  }

  loadCursor(sourceId: string): ExternalSessionIndexCursor | undefined {
    const row = this.db
      .prepare(`SELECT * FROM external_session_index_cursor WHERE source_id = ?`)
      .get(sourceId) as CursorRow | undefined;
    return row
      ? {
          sourceId: row.source_id,
          watermarkMs: row.watermark_ms,
          lastProcessedCount: row.last_processed_count,
          updatedAtMs: row.updated_at_ms,
        }
      : undefined;
  }

  saveCursor(cursor: ExternalSessionIndexCursor): void {
    this.db
      .prepare(`
        INSERT INTO external_session_index_cursor (source_id, watermark_ms, last_processed_count, updated_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          watermark_ms = excluded.watermark_ms,
          last_processed_count = excluded.last_processed_count,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(cursor.sourceId, cursor.watermarkMs, cursor.lastProcessedCount, cursor.updatedAtMs);
  }

  close(): void {
    this.db.close();
  }
}
