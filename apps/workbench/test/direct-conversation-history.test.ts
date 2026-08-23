import assert from 'node:assert/strict';
import test from 'node:test';
import { providerHistory } from '../src/runtime/use-direct-conversations.js';

test('同一会话历史按原始 user/assistant 顺序传给 Provider，且不携带活动元数据', () => {
  const history = providerHistory([
    { id: 'm1', role: 'user', text: '第一问', createdAt: 1 },
    { id: 'm2', role: 'assistant', text: '第一答', createdAt: 2, activities: [{ kind: 'reasoning', text: '不会发送', createdAt: 2 }] },
    { id: 'm3', role: 'user', text: '第二问', createdAt: 3 },
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]);
});
