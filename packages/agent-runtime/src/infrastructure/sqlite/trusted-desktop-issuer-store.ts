import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  TrustedDesktopIssuerManifestV1,
  TrustedDesktopIssuerStore,
} from '../../trusted-desktop-issuer.js';

interface IssuerRow { issuer_json: string; }

function copyManifest(manifest: TrustedDesktopIssuerManifestV1): TrustedDesktopIssuerManifestV1 {
  return { ...manifest };
}

/** SQLite WAL append-only adapter；可信宿主认证和租约签发必须经领域端口独立完成。 */
export class SqliteTrustedDesktopIssuerStore implements TrustedDesktopIssuerStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trusted_desktop_issuer_revisions (
        issuer_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        issuer_json TEXT NOT NULL,
        PRIMARY KEY(issuer_id, revision)
      );
      CREATE INDEX IF NOT EXISTS trusted_desktop_issuer_lookup_idx
        ON trusted_desktop_issuer_revisions(issuer_id, revision DESC);
    `);
  }

  load(issuerId: string): TrustedDesktopIssuerManifestV1 | undefined {
    const row = this.db.prepare(`
      SELECT issuer_json FROM trusted_desktop_issuer_revisions WHERE issuer_id = ? ORDER BY revision DESC LIMIT 1
    `).get(issuerId) as IssuerRow | undefined;
    return row ? copyManifest(JSON.parse(row.issuer_json) as TrustedDesktopIssuerManifestV1) : undefined;
  }

  append(manifest: TrustedDesktopIssuerManifestV1): void {
    this.db.prepare(`
      INSERT INTO trusted_desktop_issuer_revisions(issuer_id, revision, recorded_at_ms, issuer_json)
      VALUES (?, ?, ?, ?)
    `).run(manifest.issuerId, manifest.revision, manifest.updatedAt, JSON.stringify(copyManifest(manifest)));
  }

  list(): readonly TrustedDesktopIssuerManifestV1[] {
    const rows = this.db.prepare(`
      SELECT issuer_json FROM trusted_desktop_issuer_revisions AS current
      WHERE current.revision = (
        SELECT MAX(candidate.revision) FROM trusted_desktop_issuer_revisions AS candidate
        WHERE candidate.issuer_id = current.issuer_id
      )
      ORDER BY current.issuer_id ASC
    `).all() as unknown as readonly IssuerRow[];
    return rows.map((row) => copyManifest(JSON.parse(row.issuer_json) as TrustedDesktopIssuerManifestV1));
  }

  close(): void {
    this.db.close();
  }
}
