import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AdministratorAuthorityLeaseV1, AdministratorLeaseStore } from '../../execution-authority.js';

interface LeaseRow { lease_json: string; }

function copyLease(lease: AdministratorAuthorityLeaseV1): AdministratorAuthorityLeaseV1 {
  return { ...lease, allowedCapabilities: [...lease.allowedCapabilities] };
}

/** SQLite WAL append-only adapter；领域校验与授权决策仅由 AdministratorAuthorityLedger 完成。 */
export class SqliteAdministratorLeaseStore implements AdministratorLeaseStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS administrator_authority_leases (
        lease_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        lease_json TEXT NOT NULL,
        PRIMARY KEY(lease_id, revision)
      );
      CREATE INDEX IF NOT EXISTS administrator_authority_leases_task_run_idx
        ON administrator_authority_leases(task_id, run_id, lease_id, revision DESC);
    `);
  }

  append(lease: AdministratorAuthorityLeaseV1): void {
    this.db.prepare(`
      INSERT INTO administrator_authority_leases(lease_id, revision, task_id, run_id, recorded_at_ms, lease_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(lease.leaseId, lease.revision, lease.taskId, lease.runId, lease.issuedAt, JSON.stringify(copyLease(lease)));
  }

  latest(leaseId: string): AdministratorAuthorityLeaseV1 | undefined {
    const row = this.db.prepare(`
      SELECT lease_json FROM administrator_authority_leases WHERE lease_id = ? ORDER BY revision DESC LIMIT 1
    `).get(leaseId) as LeaseRow | undefined;
    return row ? copyLease(JSON.parse(row.lease_json) as AdministratorAuthorityLeaseV1) : undefined;
  }

  list(taskId: string, runId: string): readonly AdministratorAuthorityLeaseV1[] {
    const rows = this.db.prepare(`
      SELECT lease_json FROM administrator_authority_leases AS current
      WHERE current.task_id = ? AND current.run_id = ?
        AND current.revision = (
          SELECT MAX(candidate.revision) FROM administrator_authority_leases AS candidate
          WHERE candidate.lease_id = current.lease_id
        )
      ORDER BY current.lease_id ASC
    `).all(taskId, runId) as unknown as readonly LeaseRow[];
    return rows.map((row) => copyLease(JSON.parse(row.lease_json) as AdministratorAuthorityLeaseV1));
  }

  close(): void {
    this.db.close();
  }
}
