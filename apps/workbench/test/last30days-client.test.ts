import assert from 'node:assert/strict';
import test from 'node:test';
import { last30daysResultFrom } from '../src/runtime/last30days-client';

test('保留本地研究器返回的原始正文和公开来源', () => {
  assert.deepEqual(last30daysResultFrom({ query: 'AI tools', mode: 'last30days', rawContent: '研究正文 https://example.com/post', sources: [{ title: '公开来源', url: 'https://example.com/post' }] }), { query: 'AI tools', mode: 'last30days', rawContent: '研究正文 https://example.com/post', sources: [{ title: '公开来源', url: 'https://example.com/post' }] });
});

test('拒绝未声明模式或缺失原始正文的原生响应', () => {
  assert.throws(() => last30daysResultFrom({ query: 'x', mode: 'other', rawContent: '正文', sources: [] }), /last30days-response-invalid/);
  assert.throws(() => last30daysResultFrom({ query: 'x', mode: 'last30days-cn', rawContent: '', sources: [] }), /last30days-response-invalid/);
});
