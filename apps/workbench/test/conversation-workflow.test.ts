import assert from 'node:assert/strict';
import test from 'node:test';
import { branchConversation, checkpointConversation, conversationJson, conversationMarkdown } from '../src/runtime/conversation-workflow';

const conversation = { schemaVersion: 1 as const, id: 'conversation-source', title: '计划', selection: { providerId: 'mimo', model: 'mimo-v2.5' }, messages: [{ id: 'm1', role: 'user' as const, text: '第一问', context: '隐藏上下文', createdAt: 1 }, { id: 'm2', role: 'assistant' as const, text: '第一答', activities: [{ kind: 'reasoning' as const, text: '隐藏活动', createdAt: 2 }], createdAt: 2 }], createdAt: 1, updatedAt: 2 };

test('会话分支保留原会话且只复制所选消息之前的可见账本', () => {
  const branch = branchConversation(conversation, 'm1', 'conversation-branch', 3);
  assert.equal(conversation.messages.length, 2);
  assert.equal(branch?.messages.length, 1);
  assert.equal(branch?.id, 'conversation-branch');
});

test('检查点与导出不包含隐藏 context 或活动数据', () => {
  const checkpoint = checkpointConversation(conversation, 'checkpoint-1', '澄清完成', 3);
  assert.equal(checkpoint.messageCount, 2);
  const markdown = conversationMarkdown(conversation);
  const json = conversationJson(conversation);
  assert.doesNotMatch(markdown, /隐藏上下文|隐藏活动/);
  assert.doesNotMatch(json, /隐藏上下文|隐藏活动/);
});
