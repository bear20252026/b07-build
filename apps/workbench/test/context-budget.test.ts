import assert from 'node:assert/strict';
import test from 'node:test';
import { contextBudget, MAX_PROVIDER_HISTORY_CHARS } from '../src/runtime/context-budget';

test('上下文预算只汇总本地字符和附件元数据，不将其伪装为供应商 token', () => {
  const result = contextBudget({ messages: [{ id: 'm', role: 'user', text: '摘要', context: '完整上下文', createdAt: 1 }], memory: '记忆', draft: '草稿', pendingAttachmentBytes: 42 });
  assert.equal(result.historyCharacters, 5);
  assert.equal(result.memoryCharacters, 2);
  assert.equal(result.draftCharacters, 2);
  assert.equal(result.pendingAttachmentBytes, 42);
  assert.equal(result.limit, MAX_PROVIDER_HISTORY_CHARS);
  assert.equal(result.state, 'comfortable');
});
