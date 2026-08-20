import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SecurityPostureAuditStore, SecurityPostureReportV1 } from '../../security-posture-audit.js';

interface AuditRow { report_json: string; }

function copyReport(report: SecurityPostureReportV1): SecurityPostureReportV1 {
  return { ...report, findings: report.findings.map((finding) => ({ ...finding })) };
}

/** SQLite WAL append-only 审计账本；finding 规则仍完全由领域服务解释，HTTP GET 不调用 append。 */
export class SqliteSecurityPostureAuditStore implements SecurityPostureAuditStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_posture_audits (
        audit_id TEXT NOT NULL,
        audited_at_ms INTEGER NOT NULL,
        evidence_digest TEXT NOT NULL,
        report_json TEXT NOT NULL,
        PRIMARY KEY(audit_id, audited_at_ms)
      );
      CREATE INDEX IF NOT EXISTS security_posture_audits_history_idx
        ON security_posture_audits(audited_at_ms DESC, audit_id ASC);
    `);
  }

  append(report: SecurityPostureReportV1): void {
    this.db.prepare(`
      INSERT INTO security_posture_audits(audit_id, audited_at_ms, evidence_digest, report_json)
      VALUES (?, ?, ?, ?)
    `).run(report.auditId, report.auditedAt, report.evidenceDigest, JSON.stringify(copyReport(report)));
  }

  latest(auditId: string): SecurityPostureReportV1 | undefined {
    const row = this.db.prepare(`
      SELECT report_json FROM security_posture_audits WHERE audit_id = ? ORDER BY audited_at_ms DESC LIMIT 1
    `).get(auditId) as AuditRow | undefined;
    return row ? copyReport(JSON.parse(row.report_json) as SecurityPostureReportV1) : undefined;
  }

  list(): readonly SecurityPostureReportV1[] {
    const rows = this.db.prepare(`
      SELECT report_json FROM security_posture_audits ORDER BY audited_at_ms DESC, audit_id ASC
    `).all() as unknown as readonly AuditRow[];
    return rows.map((row) => copyReport(JSON.parse(row.report_json) as SecurityPostureReportV1));
  }

  close(): void {
    this.db.close();
  }
}
