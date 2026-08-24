import assert from 'node:assert/strict';
import test from 'node:test';
import { indexLocalKnowledge, resetLocalKnowledgeForTest, searchLocalKnowledge } from '../src/runtime/local-knowledge-ledger.js';

test('本地知识库只在显式索引时保留有界术语和来源预览，且本地检索不依赖 Provider', () => {
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window; const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } } });
  resetLocalKnowledgeForTest();
  const document = indexLocalKnowledge({ title: '设计记录', sourceKind: 'manual-text', text: 'Apple 风格使用克制的白灰蓝色与独立 Inspector。', declaredBytes: 72, projectId: 'project-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(document?.sourceKind, 'manual-text'); assert.match(document?.sourcePreview ?? '', /Apple/); assert.ok(document?.termIndex.includes('inspector'));
  assert.equal(searchLocalKnowledge('Inspector', 'project-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').length, 1);
  assert.equal(searchLocalKnowledge('克制', 'project-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').length, 1);
  const persisted = values.get('awo.local-knowledge-ledger.v1') ?? '';
  assert.doesNotMatch(persisted, /providerId|baseUrl|apiKey|prompt|response/i);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});
