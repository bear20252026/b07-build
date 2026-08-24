import assert from 'node:assert/strict';
import test from 'node:test';
import { recordSessionPerformance, resetSessionPerformanceForTest, sessionPerformanceEntries } from '../src/runtime/session-performance-ledger.js';

test('会话性能账本只记录有界数值型指标，不接受会话正文或 Provider 标识', () => {
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } } });
  resetSessionPerformanceForTest();
  recordSessionPerformance({ kind: 'timeline-frame', elapsedMs: 4.8, conversationCount: 3, messageCount: 98, renderedMessageCount: 60 });
  const [entry] = sessionPerformanceEntries();
  assert.deepEqual(entry, { schemaVersion: 1, at: entry.at, kind: 'timeline-frame', elapsedMs: 5, conversationCount: 3, messageCount: 98, renderedMessageCount: 60 });
  assert.equal('prompt' in entry, false); assert.equal('response' in entry, false); assert.equal('providerId' in entry, false); assert.equal('baseUrl' in entry, false); assert.equal('filePath' in entry, false);
  assert.match(values.get('awo.session-performance-ledger.v1') ?? '', /timeline-frame/);
  assert.doesNotMatch(values.get('awo.session-performance-ledger.v1') ?? '', /secret|prompt|response|provider/i);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

test('会话性能账本会对同类高频样本限速，避免流式刷新填满本地观察窗口', () => {
  resetSessionPerformanceForTest();
  recordSessionPerformance({ kind: 'stream-refresh', elapsedMs: 1, conversationCount: 1, messageCount: 2, renderedMessageCount: 2 });
  recordSessionPerformance({ kind: 'stream-refresh', elapsedMs: 2, conversationCount: 1, messageCount: 2, renderedMessageCount: 2 });
  assert.equal(sessionPerformanceEntries().length, 1);
});
