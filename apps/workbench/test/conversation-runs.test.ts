import assert from 'node:assert/strict';
import test from 'node:test';

import { conversationRunStatusLabel, summarizeConversationRun, summarizeConversationRuns } from '../src/runtime/conversation-runs.js';
import type { DirectConversation, DirectConversationMessage } from '../src/runtime/use-direct-conversations.js';
import type { WorkspaceFileChangeRecord } from '../src/runtime/workspace-file-rewind-contract.js';

// ---------------------------------------------------------------------------
// 会话即运行：只做只读汇总，不引入第二套执行模型。
// ---------------------------------------------------------------------------

function conversation(id: string, messages: readonly DirectConversationMessage[], updatedAt = 1): DirectConversation {
  return {
    schemaVersion: 1,
    id,
    title: `会话 ${id}`,
    selection: { providerId: 'p' },
    messages,
    createdAt: 1,
    updatedAt,
  };
}

function message(role: 'user' | 'assistant', text: string, extra: Partial<DirectConversationMessage> = {}): DirectConversationMessage {
  return { id: `${role}-${text}`, role, text, createdAt: 1, ...extra };
}

function record(path: string, sequence: number): WorkspaceFileChangeRecord {
  return { path, toolName: 'workspace_write_file', beforeContent: null, afterContent: 'x', at: 1, sequence };
}

test('目标取首条用户消息', () => {
  const run = summarizeConversationRun(conversation('c1', [message('user', '把 README 补齐'), message('assistant', '好的')]), []);
  assert.equal(run.goal, '把 README 补齐');
  assert.equal(run.messageCount, 2);
});

test('目标过长被截断', () => {
  const long = '啊'.repeat(200);
  const run = summarizeConversationRun(conversation('c1', [message('user', long)]), []);
  assert.ok(run.goal.length <= 121, `实际 ${run.goal.length}`);
  assert.ok(run.goal.endsWith('…'));
});

test('工具调用次数来自消息活动', () => {
  const run = summarizeConversationRun(conversation('c1', [
    message('user', 'x'),
    message('assistant', 'y', { activities: [
      { kind: 'tool', text: 'workspace_write_file', createdAt: 1 },
      { kind: 'reasoning', text: '想了想', createdAt: 1 },
      { kind: 'tool', text: 'browser_tool_call', createdAt: 1 },
    ] }),
  ]), []);
  assert.equal(run.toolCallCount, 2, '只数 kind=tool');
});

test('文件数按不同路径计，写入次数单独计', () => {
  const run = summarizeConversationRun(conversation('c1', [message('user', 'x')]), [
    record('a.md', 1), record('a.md', 2), record('b.md', 3),
  ]);
  assert.equal(run.filesChanged, 2, 'a.md 写两次仍算一个文件');
  assert.equal(run.fileChangeCount, 3);
});

test('状态：最后一条是用户消息即等待回复', () => {
  const run = summarizeConversationRun(conversation('c1', [message('user', 'x')]), []);
  assert.equal(run.status, 'pending');
});

test('状态：有中断收据且已回复即回合中断', () => {
  const run = summarizeConversationRun(conversation('c1', [
    message('user', 'x'),
    message('assistant', 'y', { interrupted: { executedToolCalls: 2 } }),
  ]), []);
  assert.equal(run.status, 'interrupted');
});

test('状态：等待回复优先于回合中断', () => {
  // 用户刚发了新消息还没回复 —— 那才是"当前"状态。曾经中断过是历史。
  const run = summarizeConversationRun(conversation('c1', [
    message('assistant', 'y', { interrupted: { executedToolCalls: 1 } }),
    message('user', '再来一次'),
  ]), []);
  assert.equal(run.status, 'pending');
});

test('状态：其余情况为可继续', () => {
  const run = summarizeConversationRun(conversation('c1', [message('user', 'x'), message('assistant', 'y')]), []);
  assert.equal(run.status, 'idle');
});

test('没有消息时不崩，目标为空串', () => {
  const run = summarizeConversationRun(conversation('c1', []), []);
  assert.equal(run.goal, '');
  assert.equal(run.status, 'idle');
  assert.equal(run.toolCallCount, 0);
});

test('多条运行按最近活动倒序', () => {
  const runs = summarizeConversationRuns([
    conversation('old', [message('user', 'x')], 100),
    conversation('new', [message('user', 'x')], 300),
    conversation('mid', [message('user', 'x')], 200),
  ], () => []);
  assert.deepEqual(runs.map((run) => run.conversationId), ['new', 'mid', 'old']);
});

test('按会话 id 取各自的文件日志', () => {
  const runs = summarizeConversationRuns([conversation('a', [message('user', 'x')]), conversation('b', [message('user', 'x')])], (id) => (id === 'a' ? [record('a.md', 1)] : []));
  const a = runs.find((run) => run.conversationId === 'a');
  const b = runs.find((run) => run.conversationId === 'b');
  assert.equal(a?.filesChanged, 1);
  assert.equal(b?.filesChanged, 0);
});

test('状态文案覆盖三种且没有"已完成"', () => {
  // 会话是可以随时继续的，编一个终态会让用户以为事情结束了。
  const labels = ['pending', 'interrupted', 'idle'] as const;
  assert.deepEqual(labels.map((status) => conversationRunStatusLabel(status)), ['等待回复', '回合中断', '可继续']);
  assert.equal(labels.some((status) => /完成/.test(conversationRunStatusLabel(status))), false);
});
