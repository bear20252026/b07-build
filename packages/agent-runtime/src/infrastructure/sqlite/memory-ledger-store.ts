import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyMemoryRecord, type MemoryLedgerStore, type MemoryRecord } from '../../memory-ledger.js';

interface RecordRow {
  record_json: string;
}

/**
 * MemoryRecord 的 append-only SQLite 存储。每条逻辑记忆仅保留最新快照给默认读模型，同时保留所有
 * revision 供用户审查、回放和未来的矛盾处理；不存储原始 transcript 或工具 payload。
 */
export class SqliteMemoryLedgerStore implements MemoryLedgerStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_ledger_records (
        memory_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (memory_id, revision)
      );
      CREATE INDEX IF NOT EXISTS memory_ledger_latest_idx
        ON memory_ledger_records(memory_id, revision DESC);
      CREATE INDEX IF NOT EXISTS memory_ledger_recency_idx
        ON memory_ledger_records(recorded_at_ms DESC, memory_id ASC);
    `);
  }

  load(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`
      SELECT record_json FROM memory_ledger_records
      WHERE memory_id = ? ORDER BY revision DESC LIMIT 1
    `).get(id) as RecordRow | undefined;
    return row ? copyMemoryRecord(JSON.parse(row.record_json) as MemoryRecord) : undefined;
  }

  append(record: MemoryRecord): void {
    const copy = copyMemoryRecord(record);
    this.db.prepare(`
      INSERT INTO memory_ledger_records(memory_id, revision, recorded_at_ms, record_json)
      VALUES (?, ?, ?, ?)
    `).run(copy.id, copy.revision, copy.updatedAt, JSON.stringify(copy));
  }

  list(): readonly MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT latest.record_json
      FROM memory_ledger_records AS latest
      INNER JOIN (
        SELECT memory_id, MAX(revision) AS revision
        FROM memory_ledger_records
        GROUP BY memory_id
      ) AS current
      ON current.memory_id = latest.memory_id AND current.revision = latest.revision
      ORDER BY latest.recorded_at_ms DESC, latest.memory_id ASC
    `).all() as unknown as RecordRow[];
    return rows.map((row) => copyMemoryRecord(JSON.parse(row.record_json) as MemoryRecord));
  }

  history(id: string): readonly MemoryRecord[] {
    const rows = this.db.prepare(`
      SELECT record_json FROM memory_ledger_records
      WHERE memory_id = ? ORDER BY revision ASC
    `).all(id) as unknown as RecordRow[];
    return rows.map((row) => copyMemoryRecord(JSON.parse(row.record_json) as MemoryRecord));
  }

  close(): void {
    this.db.close();
  }
}
