import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SqliteTrustedDesktopIssuerStore,
  TrustedDesktopIssuerRegistry,
} from '../src/index.js';

test('SQLite 可信桌面 issuer store 保持 append-only revision、重开审查与防御性复制', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-trusted-issuer-'));
  const filePath = join(directory, 'issuers.sqlite');
  const firstStore = new SqliteTrustedDesktopIssuerStore(filePath);
  const firstRegistry = new TrustedDesktopIssuerRegistry(firstStore);
  firstRegistry.register({ issuerId: 'host-1', displayName: 'Local Host', platform: 'windows', at: 10 });
  firstRegistry.setStatus('host-1', 'trusted', 11);
  const view = firstRegistry.get('host-1');
  if (!view) throw new Error('expected issuer');
  (view as { displayName: string }).displayName = 'mutated';
  assert.equal(firstRegistry.get('host-1')?.displayName, 'Local Host');
  firstStore.close();

  const reopenedStore = new SqliteTrustedDesktopIssuerStore(filePath);
  const reopenedRegistry = new TrustedDesktopIssuerRegistry(reopenedStore);
  assert.equal(reopenedRegistry.get('host-1')?.status, 'trusted');
  assert.equal(reopenedRegistry.get('host-1')?.revision, 2);
  reopenedRegistry.setStatus('host-1', 'revoked', 12);
  assert.equal(reopenedRegistry.list()[0].status, 'revoked');
  reopenedStore.close();
  rmSync(directory, { recursive: true, force: true });
});
