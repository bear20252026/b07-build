import assert from 'node:assert/strict';
import test from 'node:test';
import { searxngResultFrom } from '../src/runtime/searxng-local-client';

test('保留本地 SearXNG 返回的正文与来源', () => {
  const result = searxngResultFrom({ query: 'AI', summary: '本地结果', rawContent: '正文', sources: [{ title: '本地来源', url: 'https://example.com' }] });
  assert.equal(result.sources[0]?.url, 'https://example.com');
});

test('拒绝缺少正文的本地 SearXNG 响应', () => {
  assert.throws(() => searxngResultFrom({ query: 'AI', summary: '本地结果', rawContent: '', sources: [] }), /searxng-response-invalid/);
});
