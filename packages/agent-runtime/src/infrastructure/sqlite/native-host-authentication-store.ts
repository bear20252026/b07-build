import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  NativeHostBridgeTrustManifestV1,
  NativeHostBridgeTrustStore,
  NativeHostChallengeRecordV1,
  NativeHostChallengeStore,
} from '../../native-host-authentication.js';

interface JsonRow { value_json: string; }

function copyManifest(value: NativeHostBridgeTrustManifestV1): NativeHostBridgeTrustManifestV1 {
  return { ...value, allowedActions: [...value.allowedActions] };
}

function copyRecord(value: NativeHostChallengeRecordV1): NativeHostChallengeRecordV1 {
  return { ...value, challenge: { ...value.challenge } };
}

/** SQLite WAL append-only native bridge trust ledger；仅保存公钥 metadata，不保存私钥或 OS 身份材料。 */
export class SqliteNativeHostBridgeTrustStore implements NativeHostBridgeTrustStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS native_host_bridge_trust_revisions (
        issuer_id TEXT NOT NULL,
        bridge_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (issuer_id, bridge_id, revision)
      );
      CREATE INDEX IF NOT EXISTS native_host_bridge_trust_latest_idx
        ON native_host_bridge_trust_revisions(issuer_id, bridge_id, revision DESC);
    `);
  }

  load(issuerId: string, bridgeId: string): NativeHostBridgeTrustManifestV1 | undefined {
    const row = this.db.prepare(`
      SELECT value_json FROM native_host_bridge_trust_revisions
      WHERE issuer_id = ? AND bridge_id = ? ORDER BY revision DESC LIMIT 1
    `).get(issuerId, bridgeId) as JsonRow | undefined;
    return row ? copyManifest(JSON.parse(row.value_json) as NativeHostBridgeTrustManifestV1) : undefined;
  }

  append(manifest: NativeHostBridgeTrustManifestV1): void {
    this.db.prepare(`
      INSERT INTO native_host_bridge_trust_revisions(issuer_id, bridge_id, revision, value_json)
      VALUES (?, ?, ?, ?)
    `).run(manifest.issuerId, manifest.bridgeId, manifest.revision, JSON.stringify(copyManifest(manifest)));
  }

  list(): readonly NativeHostBridgeTrustManifestV1[] {
    const rows = this.db.prepare(`
      SELECT revisions.value_json FROM native_host_bridge_trust_revisions revisions
      INNER JOIN (
        SELECT issuer_id, bridge_id, MAX(revision) AS revision
        FROM native_host_bridge_trust_revisions
        GROUP BY issuer_id, bridge_id
      ) latest ON latest.issuer_id = revisions.issuer_id AND latest.bridge_id = revisions.bridge_id AND latest.revision = revisions.revision
      ORDER BY revisions.issuer_id ASC, revisions.bridge_id ASC
    `).all() as unknown as readonly JsonRow[];
    return rows.map((row) => copyManifest(JSON.parse(row.value_json) as NativeHostBridgeTrustManifestV1));
  }

  close(): void { this.db.close(); }
}

/** SQLite WAL append-only native host challenge ledger；每个 nonce 只能从 issued revision 1 追加到 consumed revision 2。 */
export class SqliteNativeHostChallengeStore implements NativeHostChallengeStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS native_host_challenge_revisions (
        nonce TEXT NOT NULL,
        revision INTEGER NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (nonce, revision)
      );
      CREATE INDEX IF NOT EXISTS native_host_challenge_latest_idx
        ON native_host_challenge_revisions(nonce, revision DESC);
    `);
  }

  load(nonce: string): NativeHostChallengeRecordV1 | undefined {
    const row = this.db.prepare(`
      SELECT value_json FROM native_host_challenge_revisions WHERE nonce = ? ORDER BY revision DESC LIMIT 1
    `).get(nonce) as JsonRow | undefined;
    return row ? copyRecord(JSON.parse(row.value_json) as NativeHostChallengeRecordV1) : undefined;
  }

  append(record: NativeHostChallengeRecordV1): void {
    this.db.prepare(`
      INSERT INTO native_host_challenge_revisions(nonce, revision, issued_at_ms, value_json)
      VALUES (?, ?, ?, ?)
    `).run(record.challenge.nonce, record.revision, record.challenge.issuedAt, JSON.stringify(copyRecord(record)));
  }

  list(): readonly NativeHostChallengeRecordV1[] {
    const rows = this.db.prepare(`
      SELECT revisions.value_json FROM native_host_challenge_revisions revisions
      INNER JOIN (
        SELECT nonce, MAX(revision) AS revision FROM native_host_challenge_revisions GROUP BY nonce
      ) latest ON latest.nonce = revisions.nonce AND latest.revision = revisions.revision
      ORDER BY revisions.issued_at_ms DESC, revisions.nonce ASC
    `).all() as unknown as readonly JsonRow[];
    return rows.map((row) => copyRecord(JSON.parse(row.value_json) as NativeHostChallengeRecordV1));
  }

  close(): void { this.db.close(); }
}
