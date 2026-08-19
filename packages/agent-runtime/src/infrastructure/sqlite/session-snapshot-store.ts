import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  copySessionSnapshot,
  type LocalSessionSnapshot,
  type SessionSnapshotStore,
} from '../../session-control-plane.js';

interface SnapshotRow {
  snapshot_json: string;
}

/**
 * durable 会话元数据的本地 append-only 存储。它只接受 LocalSessionControlPlane 写入的防御性 DTO；
 * transcript、模型上下文和工具 payload 不属于本表。WAL 支持本地单写多读与后续控制面投影。
 */
export class SqliteSessionSnapshotStore implements SessionSnapshotStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_snapshots (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS session_snapshots_latest_idx
        ON session_snapshots(session_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS session_snapshots_recency_idx
        ON session_snapshots(recorded_at_ms DESC, session_id ASC);
    `);
  }

  load(sessionId: string): LocalSessionSnapshot | undefined {
    const row = this.db
      .prepare(`
        SELECT snapshot_json FROM session_snapshots
        WHERE session_id = ?
        ORDER BY sequence DESC LIMIT 1
      `)
      .get(sessionId) as SnapshotRow | undefined;
    return row ? copySessionSnapshot(JSON.parse(row.snapshot_json) as LocalSessionSnapshot) : undefined;
  }

  list(): readonly LocalSessionSnapshot[] {
    const rows = this.db
      .prepare(`
        SELECT latest.snapshot_json
        FROM session_snapshots AS latest
        INNER JOIN (
          SELECT session_id, MAX(sequence) AS sequence
          FROM session_snapshots
          GROUP BY session_id
        ) AS current
        ON current.session_id = latest.session_id AND current.sequence = latest.sequence
        ORDER BY latest.recorded_at_ms DESC, latest.session_id ASC
      `)
      .all() as unknown as SnapshotRow[];
    return rows.map((row) => copySessionSnapshot(JSON.parse(row.snapshot_json) as LocalSessionSnapshot));
  }

  /** 供回放和控制面镜像使用的从早到晚 immutable snapshots。 */
  history(sessionId: string): readonly LocalSessionSnapshot[] {
    const rows = this.db
      .prepare(`
        SELECT snapshot_json FROM session_snapshots
        WHERE session_id = ?
        ORDER BY sequence ASC
      `)
      .all(sessionId) as unknown as SnapshotRow[];
    return rows.map((row) => copySessionSnapshot(JSON.parse(row.snapshot_json) as LocalSessionSnapshot));
  }

  save(snapshot: LocalSessionSnapshot): void {
    if (snapshot.scope.persistence !== 'durable') {
      throw new Error('SqliteSessionSnapshotStore 只接受 durable 会话快照');
    }
    const record = copySessionSnapshot(snapshot);
    this.db
      .prepare(`
        INSERT INTO session_snapshots(session_id, sequence, recorded_at_ms, snapshot_json)
        SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?
        FROM session_snapshots WHERE session_id = ?
      `)
      .run(record.sessionId, record.updatedAt, JSON.stringify(record), record.sessionId);
  }

  close(): void {
    this.db.close();
  }
}
