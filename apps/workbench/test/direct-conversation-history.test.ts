import assert from 'node:assert/strict';
import test from 'node:test';
import { interruptedTurnNote, mergeStreamingAssistantMessage, providerHistory, streamingAssistantMessage } from '../src/runtime/use-direct-conversations.js';

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

// ---------------------------------------------------------------------------
// 中断收据：工具改的是真实文件，不会因为后续回答失败而回滚。
// 收据必须（a）留在正文里给人看，（b）在重试时带进上下文给模型看。
// ---------------------------------------------------------------------------

test('中断提示必须说明操作已完成且不会自动回滚', () => {
  const note = interruptedTurnNote(2, new Error('provider-sse-error: 上游 502'));
  // 少了这句，用户会以为整件事失败了，重试一遍把工作区又改一次。
  assert.match(note, /已执行 2 次工具调用/);
  assert.match(note, /不会自动回滚/);
  assert.match(note, /上游 502/);
});

test('重试时把中断收据带进发给模型的上下文', () => {
  const history = providerHistory([
    { id: 'm1', role: 'user', text: '改一下配置', createdAt: 1 },
    { id: 'm2', role: 'assistant', text: '我改了。', createdAt: 2, interrupted: { executedToolCalls: 3 } },
  ]);
  // 重试是全新请求：模型看不到上一回合执行过什么，很可能把同一批工具再调一遍。
  assert.match(history[1]!.content, /改一下配置|我改了。/);
  assert.match(history[1]!.content, /3 次工具调用后中断/);
  assert.match(history[1]!.content, /不要重复执行/);
});

test('未中断的消息不带收据附加语', () => {
  const history = providerHistory([{ id: 'm1', role: 'assistant', text: '正常回答', createdAt: 1 }]);
  assert.equal(history[0]!.content, '正常回答');
});

test('收据计数非正或非整数时被丢弃', () => {
  // 来自持久化存储，必须校验：伪造一条 interrupted 不该影响发给模型的上下文。
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const history = providerHistory([{ id: 'm1', role: 'assistant', text: 'x', createdAt: 1, interrupted: { executedToolCalls: bad } }]);
    assert.equal(history[0]!.content, 'x', `executedToolCalls=${bad} 不应产生收据`);
  }
});
