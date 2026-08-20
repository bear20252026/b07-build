import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteComponentManagementReceiptStore } from '../src/index.js';

function receipt(operationId: string, componentId: string, outcome: 'applied' | 'rejected', recordedAt: number) {
  return {
    schemaVersion: 1 as const,
    operationId,
    issuerId: 'desktop-host',
    action: 'verify-digest' as const,
    componentId,
    payloadDigest: 'a'.repeat(64),
    outcome,
    rejectionCode: outcome === 'rejected' ? 'issuer-untrusted' as const : undefined,
    recordedAt,
    canExecute: false as const,
    canAutoRemediate: false as const,
  };
}

test('SQLite Component Management receipt store 保留可重开、可筛选且防御性复制的 append-only 审计历史', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-component-management-'));
  const path = join(root, 'receipts.sqlite');
  try {
    const store = new SqliteComponentManagementReceiptStore(path);
    store.append(receipt('op-1', 'component-a', 'applied', 1));
    store.append(receipt('op-2', 'component-a', 'rejected', 2));
    store.close();

    const reopened = new SqliteComponentManagementReceiptStore(path);
    assert.deepEqual(reopened.list('component-a').map((item) => [item.operationId, item.outcome]), [['op-2', 'rejected'], ['op-1', 'applied']]);
    const view = reopened.load('op-1')!;
    (view as { outcome: string }).outcome = 'mutated';
    assert.equal(reopened.load('op-1')!.outcome, 'applied');
    reopened.close();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
