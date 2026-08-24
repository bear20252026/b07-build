import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionPerformanceHealth } from '../src/runtime/session-performance-health.js';

test('本地性能健康摘要只依据数值指标区分等待、稳定和需要关注状态', () => {
  const entries = [{ schemaVersion: 1 as const, at: 1, kind: 'conversation-persist' as const, elapsedMs: 80, conversationCount: 2, messageCount: 10 }, { schemaVersion: 1 as const, at: 2, kind: 'stream-refresh' as const, elapsedMs: 4, conversationCount: 2, messageCount: 10, renderedMessageCount: 10 }];
  const health = sessionPerformanceHealth(entries);
  assert.equal(health.find((item) => item.kind === 'conversation-persist')?.state, 'attention');
  assert.equal(health.find((item) => item.kind === 'stream-refresh')?.state, 'stable');
  assert.equal(health.find((item) => item.kind === 'timeline-frame')?.state, 'awaiting');
  assert.doesNotMatch(JSON.stringify(health), /providerId|"prompt"|"response"|baseUrl|apiKey/i);
});
