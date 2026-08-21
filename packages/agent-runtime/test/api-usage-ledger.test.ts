import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiUsageLedger, InMemoryApiUsageStore, SqliteApiUsageStore } from '../src/index.js';

function completed(overrides: Partial<{ providerId: string; profileId: string; profileRevision: number; model: string; latencyMs: number; outputCharacters: number; recordedAt: number }> = {}) {
  return {
    providerId: 'deepseek', profileId: 'provider.deepseek', profileRevision: 2, model: 'deepseek-chat',
    dataBoundary: 'remote-allowed' as const, latencyMs: 142, outputCharacters: 88, recordedAt: 1_000, ...overrides,
  };
}

test('API 用量账本只保存已完成调用的脱敏事实，并提供稳定聚合', () => {
  const ledger = new ApiUsageLedger(new InMemoryApiUsageStore(), () => '00000000-0000-4000-8000-000000000001');
  const receipt = ledger.recordCompleted(completed());
  assert.equal(receipt.usageId, 'usage:00000000-0000-4000-8000-000000000001');
  assert.equal(receipt.tokenStatus, 'not-reported');
  assert.equal(JSON.stringify(receipt).includes('prompt'), false);
  assert.equal(receipt.containsOutput, false);
  assert.equal(ledger.summary(2_000).totalCalls, 1);
  assert.deepEqual(ledger.summary(2_000).models, [{ providerId: 'deepseek', model: 'deepseek-chat', callCount: 1, totalLatencyMs: 142, totalOutputCharacters: 88, tokenStatus: 'not-reported' }]);
});

test('API 用量账本拒绝泄漏标记和不安全标识符', () => {
  const ledger = new ApiUsageLedger(new InMemoryApiUsageStore());
  assert.throws(() => ledger.recordCompleted(completed({ providerId: 'bad provider' })), /providerId/);
  const polluted = {
    schemaVersion: 1, usageId: 'usage:1', recordedAt: 1, providerId: 'deepseek', profileId: 'provider.deepseek', profileRevision: 1,
    model: 'deepseek-chat', dataBoundary: 'remote-allowed', latencyMs: 1, outputCharacters: 1, tokenStatus: 'not-reported',
    canReadSecret: false, containsPrompt: true, containsOutput: false, containsEndpoint: false,
  } as unknown as import('../src/index.js').ApiUsageReceiptV1;
  assert.throws(() => new InMemoryApiUsageStore().append(polluted), /不得包含/);
});

test('SQLite API 用量账本可重开且不会存储内容列', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-api-usage-'));
  const path = join(root, 'usage.sqlite');
  try {
    const firstStore = new SqliteApiUsageStore(path);
    const first = new ApiUsageLedger(firstStore, () => '00000000-0000-4000-8000-000000000002');
    first.recordCompleted(completed());
    firstStore.close();
    const secondStore = new SqliteApiUsageStore(path);
    const second = new ApiUsageLedger(secondStore);
    const receipt = second.recent()[0];
    assert.equal(receipt?.providerId, 'deepseek');
    assert.equal(Object.hasOwn(receipt ?? {}, 'output'), false);
    assert.equal(second.summary(2_000).totalOutputCharacters, 88);
    secondStore.close();
  } finally { rmSync(root, { force: true, recursive: true }); }
});
