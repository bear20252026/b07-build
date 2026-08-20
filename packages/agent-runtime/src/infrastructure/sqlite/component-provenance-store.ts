import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ComponentLockfileStore,
  ComponentLockfileV1,
  ComponentProvenanceStore,
  ComponentProvenanceV1,
} from '../../component-provenance.js';

interface ProvenanceRow { provenance_json: string; }
interface LockfileRow { lockfile_json: string; }

function copyProvenance(value: ComponentProvenanceV1): ComponentProvenanceV1 {
  return { ...value };
}

function copyLockfile(value: ComponentLockfileV1): ComponentLockfileV1 {
  return { ...value, entries: value.entries.map((entry) => ({ ...entry })) };
}

/** SQLite WAL append-only 构件来源账本；领域服务负责状态机与摘要校验。 */
export class SqliteComponentProvenanceStore implements ComponentProvenanceStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS component_provenance_revisions (
        component_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        review_status TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        PRIMARY KEY(component_id, revision)
      );
      CREATE INDEX IF NOT EXISTS component_provenance_revisions_latest_idx
        ON component_provenance_revisions(component_id, revision DESC);
    `);
  }

  load(componentId: string): ComponentProvenanceV1 | undefined {
    const row = this.db.prepare(`
      SELECT provenance_json FROM component_provenance_revisions
      WHERE component_id = ? ORDER BY revision DESC LIMIT 1
    `).get(componentId) as ProvenanceRow | undefined;
    return row ? copyProvenance(JSON.parse(row.provenance_json) as ComponentProvenanceV1) : undefined;
  }

  append(provenance: ComponentProvenanceV1): void {
    const current = this.load(provenance.componentId);
    if (!current && provenance.revision !== 1) throw new Error('首个 provenance revision 必须为 1');
    if (current && provenance.revision !== current.revision + 1) throw new Error('provenance revision 必须连续递增');
    this.db.prepare(`
      INSERT INTO component_provenance_revisions(component_id, revision, review_status, recorded_at_ms, provenance_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(provenance.componentId, provenance.revision, provenance.reviewStatus, provenance.recordedAt, JSON.stringify(copyProvenance(provenance)));
  }

  list(): readonly ComponentProvenanceV1[] {
    const rows = this.db.prepare(`
      SELECT current.provenance_json FROM component_provenance_revisions AS current
      WHERE current.revision = (
        SELECT MAX(candidate.revision) FROM component_provenance_revisions AS candidate
        WHERE candidate.component_id = current.component_id
      )
      ORDER BY current.component_id ASC
    `).all() as unknown as readonly ProvenanceRow[];
    return rows.map((row) => copyProvenance(JSON.parse(row.provenance_json) as ComponentProvenanceV1));
  }

  history(componentId: string): readonly ComponentProvenanceV1[] {
    const rows = this.db.prepare(`
      SELECT provenance_json FROM component_provenance_revisions
      WHERE component_id = ? ORDER BY revision ASC
    `).all(componentId) as unknown as readonly ProvenanceRow[];
    return rows.map((row) => copyProvenance(JSON.parse(row.provenance_json) as ComponentProvenanceV1));
  }

  close(): void {
    this.db.close();
  }
}

/** SQLite WAL append-only lockfile 账本；写入者必须显式选择 revision 与条目，读取者不会刷新或修复 lock。 */
export class SqliteComponentLockfileStore implements ComponentLockfileStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS component_lockfile_revisions (
        revision INTEGER PRIMARY KEY,
        locked_at_ms INTEGER NOT NULL,
        lock_digest TEXT NOT NULL,
        lockfile_json TEXT NOT NULL
      );
    `);
  }

  load(): ComponentLockfileV1 | undefined {
    const row = this.db.prepare(`
      SELECT lockfile_json FROM component_lockfile_revisions ORDER BY revision DESC LIMIT 1
    `).get() as LockfileRow | undefined;
    return row ? copyLockfile(JSON.parse(row.lockfile_json) as ComponentLockfileV1) : undefined;
  }

  append(lockfile: ComponentLockfileV1): void {
    const current = this.load();
    if (!current && lockfile.revision !== 1) throw new Error('首个 lockfile revision 必须为 1');
    if (current && lockfile.revision !== current.revision + 1) throw new Error('lockfile revision 必须连续递增');
    this.db.prepare(`
      INSERT INTO component_lockfile_revisions(revision, locked_at_ms, lock_digest, lockfile_json)
      VALUES (?, ?, ?, ?)
    `).run(lockfile.revision, lockfile.lockedAt, lockfile.lockDigest, JSON.stringify(copyLockfile(lockfile)));
  }

  history(): readonly ComponentLockfileV1[] {
    const rows = this.db.prepare(`
      SELECT lockfile_json FROM component_lockfile_revisions ORDER BY revision ASC
    `).all() as unknown as readonly LockfileRow[];
    return rows.map((row) => copyLockfile(JSON.parse(row.lockfile_json) as ComponentLockfileV1));
  }

  close(): void {
    this.db.close();
  }
}
