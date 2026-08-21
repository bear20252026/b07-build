import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpApiUsageClient } from '../src/runtime/api-usage-client.js';

const summary = {
  schemaVersion: 1, generatedAt: 2_000, totalCalls: 1, totalLatencyMs: 120, totalOutputCharacters: 80,
  tokenStatus: 'not-reported', latestRecordedAt: 1_000,
  models: [{ providerId: 'deepseek', model: 'deepseek-chat', callCount: 1, totalLatencyMs: 120, totalOutputCharacters: 80, tokenStatus: 'not-reported' }],
};

const receipt = {
  schemaVersion: 1, usageId: 'usage:00000000-0000-4000-8000-000000000001', recordedAt: 1_000,
  providerId: 'deepseek', profileId: 'provider.deepseek', profileRevision: 1, model: 'deepseek-chat', dataBoundary: 'remote-allowed',
  latencyMs: 120, outputCharacters: 80, tokenStatus: 'not-reported', canReadSecret: false, containsPrompt: false, containsOutput: false, containsEndpoint: false,
};

test('API 使用客户端只读取经过形状校验的本机摘要与脱敏收据', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url) => { urls.push(String(url)); return Response.json(String(url).includes('/summary') ? summary : [receipt]); }) as typeof fetch;
  try {
    const client = new HttpApiUsageClient('http://127.0.0.1:4318');
    assert.equal((await client.summary()).totalCalls, 1);
    const receipts = await client.receipts();
    assert.equal(receipts[0]?.containsPrompt, false);
    assert.equal(JSON.stringify(receipts[0]).includes('outputDigest'), false);
    assert.deepEqual(urls, ['http://127.0.0.1:4318/api/usage/summary?limit=500', 'http://127.0.0.1:4318/api/usage/receipts?limit=100']);
  } finally { globalThis.fetch = originalFetch; }
});

test('API 使用客户端拒绝违反不记录内容承诺的收据', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([{ ...receipt, containsPrompt: true }])) as typeof fetch;
  try {
    await assert.rejects(() => new HttpApiUsageClient().receipts(), /收据字段无效/);
  } finally { globalThis.fetch = originalFetch; }
});
