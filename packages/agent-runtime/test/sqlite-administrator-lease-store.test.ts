import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AdministratorAuthorityLedger, SqliteAdministratorLeaseStore } from '../src/index.js';

const digest = createHash('sha256').update('maintenance').digest('hex');

test('SQLite 管理员租约 store 按 revision 追加，并在重开后仅投影指定 task/run 的最新租约', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-admin-lease-'));
  const path = join(root, 'administrator-leases.sqlite');
  try {
    const first = new SqliteAdministratorLeaseStore(path);
    const ledger = new AdministratorAuthorityLedger(first, () => 1_000);
    ledger.issue({ leaseId: 'lease-a', operatorId: 'owner', taskId: 'task-a', runId: 'run-a', allowedCapabilities: ['shell.execute'], issuedAt: 1_000, expiresAt: 61_000, reasonDigest: digest });
    ledger.issue({ leaseId: 'lease-b', operatorId: 'owner', taskId: 'task-b', runId: 'run-b', allowedCapabilities: ['filesystem.write'], issuedAt: 1_000, expiresAt: 61_000, reasonDigest: digest });
    ledger.revoke('lease-a', 'owner', 1_001);
    first.close();

    const reopened = new SqliteAdministratorLeaseStore(path);
    const leases = reopened.list('task-a', 'run-a') as unknown as Array<{ allowedCapabilities: string[]; status: string; revision: number }>;
    assert.deepEqual(leases, [{
      schemaVersion: 1, leaseId: 'lease-a', revision: 2, operatorId: 'owner', taskId: 'task-a', runId: 'run-a', allowedCapabilities: ['shell.execute'], issuedAt: 1_000, expiresAt: 61_000, reasonDigest: digest, status: 'revoked', canOverrideApproval: true, canOverrideDeny: false, canReadSecrets: false, canReplaySideEffects: false,
    }]);
    leases[0].allowedCapabilities.push('browser.control');
    assert.deepEqual(reopened.list('task-a', 'run-a')[0].allowedCapabilities, ['shell.execute']);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
