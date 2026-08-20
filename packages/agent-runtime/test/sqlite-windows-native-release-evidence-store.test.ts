import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteWindowsNativeHostReleaseEvidenceStore } from '../src/index.js';

function evidence(evidenceId: string, capturedAt: number, bridgeId = 'windows-native-host') {
  return {
    schemaVersion: 1 as const, evidenceId, platform: 'windows' as const, architecture: 'x64' as const,
    issuerId: 'desktop-host', bridgeId, helperId: 'awo-native-helper', protocolVersion: 'native-auth.v1',
    binaryDigest: 'a'.repeat(64), signerThumbprintDigest: 'b'.repeat(64), authenticodeStatus: 'valid' as const,
    capturedAt, canExecute: false as const, canAutoTrust: false as const,
  };
}

test('SQLite Windows release evidence ledger 可关闭重开、按受控身份筛选且不泄露可变记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-windows-release-evidence-'));
  const path = join(root, 'evidence.sqlite');
  try {
    const store = new SqliteWindowsNativeHostReleaseEvidenceStore(path);
    store.append(evidence('evidence-old', 1));
    store.append(evidence('evidence-new', 2));
    store.append(evidence('other-bridge', 3, 'other-bridge'));
    store.close();

    const reopened = new SqliteWindowsNativeHostReleaseEvidenceStore(path);
    assert.deepEqual(reopened.list('desktop-host', 'windows-native-host').map((item) => item.evidenceId), ['evidence-new', 'evidence-old']);
    const view = reopened.load('evidence-new')!;
    (view as { binaryDigest: string }).binaryDigest = 'f'.repeat(64);
    assert.equal(reopened.load('evidence-new')?.binaryDigest, 'a'.repeat(64));
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
