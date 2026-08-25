import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeStreamingAssistantMessage, providerHistory, streamingAssistantMessage } from '../src/runtime/use-direct-conversations.js';

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

test('后续 Provider 请求使用会话保存的长输入 TXT 上下文而非丢失原始文本', () => {
  const history = providerHistory([{ id: 'm4', role: 'user', text: '摘要', context: '摘要\n--- 自动生成的长输入 TXT：conversation.txt ---\n完整长文本', createdAt: 4 }]);
  assert.equal(history[0]?.content, '摘要\n--- 自动生成的长输入 TXT：conversation.txt ---\n完整长文本');
});

test('连续两轮流式助手消息使用独立稳定 ID，后一轮不会覆盖前一轮已完成回复', () => {
  const first = streamingAssistantMessage('message-assistant-1', '第一答', 2, 'model-a');
  const afterFirst = mergeStreamingAssistantMessage([{ id: 'message-user-1', role: 'user', text: '第一问', createdAt: 1 }], first);
  const second = streamingAssistantMessage('message-assistant-2', '第二答', 4, 'model-a');
  const afterSecond = mergeStreamingAssistantMessage([...afterFirst, { id: 'message-user-2', role: 'user', text: '第二问', createdAt: 3 }], second);
  assert.deepEqual(afterSecond.map((message) => [message.id, message.text]), [['message-user-1', '第一问'], ['message-assistant-1', '第一答'], ['message-user-2', '第二问'], ['message-assistant-2', '第二答']]);
});
