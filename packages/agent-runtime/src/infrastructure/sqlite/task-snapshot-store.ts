// 一个文件=一种作用：SQLite append-only 快照适配器；不编排任务、不决定权限、不渲染 UI。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LocalTaskSnapshot, TaskSnapshotStore } from '../../recoverable-task-runtime.js';

interface SnapshotRow {
  snapshot_json: string;
}

function cloneSnapshot(snapshot: LocalTaskSnapshot): LocalTaskSnapshot {
  return {
    ...snapshot,
    nodeOutcomes: { ...snapshot.nodeOutcomes },
    stats: snapshot.stats ? { ...snapshot.stats } : undefined,
  };
}

/**
 * 任务快照的本地持久化实现。
 *
 * 每次 `save` 通过一条原子 INSERT 追加新的 sequence，不覆盖历史记录；WAL 模式让后续 Rust
 * 控制面、UI 读模型与 Agent 运行时可采用“单写多读”的本地优先模型。Schema 保持 JSON payload，
 * 避免存储层耦合领域字段演进。此适配器使用 Node 内置 `node:sqlite`，运行时需启用
 * `--experimental-sqlite`，避免外部 native addon 造成 ABI/崩溃风险。
 */
export class SqliteTaskSnapshotStore implements TaskSnapshotStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_snapshots (
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (task_id, run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS task_snapshots_latest_idx
        ON task_snapshots(task_id, run_id, sequence DESC);
    `);
  }

  load(taskId: string, runId: string): LocalTaskSnapshot | undefined {
    const row = this.db
      .prepare(`
        SELECT snapshot_json FROM task_snapshots
        WHERE task_id = ? AND run_id = ?
        ORDER BY sequence DESC LIMIT 1
      `)
      .get(taskId, runId) as SnapshotRow | undefined;
    return row ? cloneSnapshot(JSON.parse(row.snapshot_json) as LocalTaskSnapshot) : undefined;
  }

  /** 返回从早到晚的不可变副本，供回放、诊断和 Rust 控制面镜像消费。 */
  history(taskId: string, runId: string): readonly LocalTaskSnapshot[] {
    const rows = this.db
      .prepare(`
        SELECT snapshot_json FROM task_snapshots
        WHERE task_id = ? AND run_id = ?
        ORDER BY sequence ASC
      `)
      .all(taskId, runId) as unknown as SnapshotRow[];
    return rows.map((row) => cloneSnapshot(JSON.parse(row.snapshot_json) as LocalTaskSnapshot));
  }

  save(snapshot: LocalTaskSnapshot): void {
    const record = cloneSnapshot(snapshot);
    // 单条 SQL 在 SQLite 写锁下计算下一个 sequence 并插入，避免“读取 max → 插入”之间的覆盖窗口。
    this.db
      .prepare(`
        INSERT INTO task_snapshots(task_id, run_id, sequence, recorded_at_ms, snapshot_json)
        SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?
        FROM task_snapshots WHERE task_id = ? AND run_id = ?
      `)
      .run(
        record.taskId,
        record.runId,
        record.updatedAt,
        JSON.stringify(record),
        record.taskId,
        record.runId,
      );
  }

  close(): void {
    this.db.close();
  }
}
