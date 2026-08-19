import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskEvent } from '@awo/protocol';
import { ContextBudgeter } from '../src/context-budgeter.js';

test('上下文超额时按优先级稳定保留，并发射可校验的压缩事件', () => {
  const result = new ContextBudgeter().select({
    taskId: 'task-context',
    runId: 'run-context',
    at: 20,
    maxTokens: 7,
    items: [
      { id: 'old-tool-output', estimatedTokens: 5, priority: 1 },
      { id: 'user-goal', estimatedTokens: 3, priority: 10 },
      { id: 'latest-error', estimatedTokens: 4, priority: 8 },
    ],
  });

  assert.deepEqual(result.retained.map((item) => item.id), ['user-goal', 'latest-error']);
  assert.deepEqual(result.compacted.map((item) => item.id), ['old-tool-output']);
  assert.equal(result.estimatedTokensBefore, 12);
  assert.equal(result.estimatedTokensAfter, 7);
  assert.ok(result.event);
  assert.equal(isTaskEvent(result.event), true);
});

test('预算足够时保留完整上下文且不生成压缩事件', () => {
  const result = new ContextBudgeter().select({
    taskId: 'task-context',
    runId: 'run-context',
    at: 21,
    maxTokens: 10,
    items: [
      { id: 'goal', estimatedTokens: 3, priority: 1 },
      { id: 'plan', estimatedTokens: 4, priority: 1 },
    ],
  });

  assert.equal(result.compacted.length, 0);
  assert.equal(result.event, undefined);
  assert.equal(result.estimatedTokensAfter, 7);
});

test('拒绝重复上下文标识，防止压缩结果无法回放', () => {
  assert.throws(
    () =>
      new ContextBudgeter().select({
        taskId: 'task-context',
        runId: 'run-context',
        at: 22,
        maxTokens: 1,
        items: [
          { id: 'same', estimatedTokens: 1, priority: 1 },
          { id: 'same', estimatedTokens: 1, priority: 1 },
        ],
      }),
    /重复/,
  );
});
