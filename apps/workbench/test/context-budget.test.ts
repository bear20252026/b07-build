import assert from 'node:assert/strict';
import test from 'node:test';
import { contextBudget, contextWindowTokensFor, DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_OUTPUT_RESERVE_TOKENS, ESTIMATED_CHARS_PER_TOKEN, historyCharBudgetFor, MAX_PROVIDER_HISTORY_CHARS } from '../src/runtime/context-budget';

test('上下文预算只汇总本地字符和附件元数据，不将其伪装为供应商 token', () => {
  const result = contextBudget({ messages: [{ id: 'm', role: 'user', text: '摘要', context: '完整上下文', createdAt: 1 }], memory: '记忆', draft: '草稿', pendingAttachmentBytes: 42 });
  assert.equal(result.historyCharacters, 5);
  assert.equal(result.memoryCharacters, 2);
  assert.equal(result.draftCharacters, 2);
  assert.equal(result.pendingAttachmentBytes, 42);
  assert.equal(result.limit, historyCharBudgetFor());
  assert.equal(result.state, 'comfortable');
});

test('未声明窗口的模型走保守默认窗口，而不是固定的 100 万字符', () => {
  assert.equal(contextWindowTokensFor(), DEFAULT_CONTEXT_WINDOW_TOKENS);
  assert.equal(contextWindowTokensFor('some-unlisted-model'), DEFAULT_CONTEXT_WINDOW_TOKENS);
  const expected = (DEFAULT_CONTEXT_WINDOW_TOKENS - DEFAULT_OUTPUT_RESERVE_TOKENS) * ESTIMATED_CHARS_PER_TOKEN;
  assert.equal(historyCharBudgetFor('some-unlisted-model'), expected);
  assert.ok(expected < MAX_PROVIDER_HISTORY_CHARS, '默认预算必须低于安全上限，否则等于没做预算');
});

test('窗口折算永远不超过安全上限', () => {
  assert.ok(historyCharBudgetFor() <= MAX_PROVIDER_HISTORY_CHARS);
  assert.ok(historyCharBudgetFor('anything') <= MAX_PROVIDER_HISTORY_CHARS);
});

test('预算收紧后，同样的字符量会更早进入告警态', () => {
  const messages = Array.from({ length: 40 }, (_unused, index) => ({ id: `m${index}`, role: 'user' as const, text: 'x'.repeat(10_000), createdAt: index }));
  const result = contextBudget({ messages, memory: '', draft: '', pendingAttachmentBytes: 0 });
  assert.equal(result.historyCharacters, 400_000);
  assert.ok(result.limit < 400_000, '40 万字符应已超出默认窗口预算');
  assert.equal(result.state, 'near-limit');
});
