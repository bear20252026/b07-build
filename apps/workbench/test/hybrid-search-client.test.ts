import assert from 'node:assert/strict';
import test from 'node:test';
import { hybridSearchResultFrom } from '../src/runtime/hybrid-search-client';

test('保留混合检索的后端回执、归属和来源', () => {
  const actual = hybridSearchResultFrom({ query: 'AI', rawContent: '正文', sources: [{ backend: 'exa', title: '网页', url: 'https://example.com' }], receipts: [{ backend: 'exa', state: 'succeeded', detail: '已完成', sourceCount: 1 }, { backend: 'last30days', state: 'failed', detail: 'last30days-python-unavailable', sourceCount: 0 }] });
  assert.equal(actual.receipts.length, 2);
  assert.equal(actual.sources[0]?.backend, 'exa');
});

test('拒绝缺失原始正文或非法回执的混合搜索响应', () => {
  assert.throws(() => hybridSearchResultFrom({ query: 'AI', rawContent: '', sources: [], receipts: [] }), /hybrid-search-response-invalid/);
  assert.throws(() => hybridSearchResultFrom({ query: 'AI', rawContent: '正文', sources: [], receipts: [{ backend: 'exa', state: 'unknown', detail: 'x', sourceCount: 0 }] }), /hybrid-search-response-invalid/);
});
