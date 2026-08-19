import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpKnowledgeSearchClient } from '../src/runtime/knowledge-client.js';

const citation = {
  documentId: 'runtime',
  chunkId: 'runtime:chunk:0',
  sourceUri: 'file:///docs/runtime.md',
  title: '本地任务恢复',
  excerpt: 'SQLite 快照以 append-only 方式保留任务历史。',
  score: 0.81,
};

test('知识客户端编码查询并返回经过形状校验的来源引用', async () => {
  const originalFetch = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (nextUrl) => {
    url = String(nextUrl);
    return Response.json([citation]);
  }) as typeof fetch;
  try {
    const results = await new HttpKnowledgeSearchClient('/api/knowledge/search').search('SQLite 快照', 3);
    assert.equal(url, '/api/knowledge/search?q=SQLite+%E5%BF%AB%E7%85%A7&limit=3');
    assert.deepEqual(results, [citation]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('知识客户端拒绝不带来源或分数的服务响应', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([{ documentId: 'runtime' }])) as typeof fetch;
  try {
    await assert.rejects(() => new HttpKnowledgeSearchClient().search('SQLite'), /无效引用列表/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
