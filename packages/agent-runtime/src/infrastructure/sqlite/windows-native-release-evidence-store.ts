import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WindowsNativeHostReleaseEvidenceStore, WindowsNativeHostReleaseEvidenceV1 } from '../../windows-native-release-evidence.js';

interface JsonRow { value_json: string; }

function copyEvidence(evidence: WindowsNativeHostReleaseEvidenceV1): WindowsNativeHostReleaseEvidenceV1 {
  return { ...evidence };
}

/** Windows-only release evidence 的 SQLite WAL append-only ledger；只存受限摘要 metadata，不存二进制路径、证书正文或私钥。 */
export class SqliteWindowsNativeHostReleaseEvidenceStore implements WindowsNativeHostReleaseEvidenceStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS windows_native_release_evidence (
        evidence_id TEXT PRIMARY KEY,
        issuer_id TEXT NOT NULL,
        bridge_id TEXT NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        value_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS windows_native_release_evidence_identity_idx
        ON windows_native_release_evidence(issuer_id, bridge_id, captured_at_ms DESC, evidence_id ASC);
    `);
  }

  load(evidenceId: string): WindowsNativeHostReleaseEvidenceV1 | undefined {
    const row = this.db.prepare('SELECT value_json FROM windows_native_release_evidence WHERE evidence_id = ?').get(evidenceId) as JsonRow | undefined;
    return row ? copyEvidence(JSON.parse(row.value_json) as WindowsNativeHostReleaseEvidenceV1) : undefined;
  }

  append(evidence: WindowsNativeHostReleaseEvidenceV1): void {
    this.db.prepare(`
      INSERT INTO windows_native_release_evidence(evidence_id, issuer_id, bridge_id, captured_at_ms, value_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(evidence.evidenceId, evidence.issuerId, evidence.bridgeId, evidence.capturedAt, JSON.stringify(copyEvidence(evidence)));
  }

  list(issuerId?: string, bridgeId?: string): readonly WindowsNativeHostReleaseEvidenceV1[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (issuerId !== undefined) { clauses.push('issuer_id = ?'); parameters.push(issuerId); }
    if (bridgeId !== undefined) { clauses.push('bridge_id = ?'); parameters.push(bridgeId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT value_json FROM windows_native_release_evidence ${where}
      ORDER BY captured_at_ms DESC, evidence_id ASC
    `).all(...parameters) as unknown as readonly JsonRow[];
    return rows.map((row) => copyEvidence(JSON.parse(row.value_json) as WindowsNativeHostReleaseEvidenceV1));
  }

  close(): void { this.db.close(); }
}
