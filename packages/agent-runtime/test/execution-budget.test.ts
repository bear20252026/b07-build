import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryExecutionBudget } from '../src/execution-budget.js';

test('执行预算在超过总步骤数前允许调用，并在超限时阻断', () => {
  const budget = new InMemoryExecutionBudget({ maxToolCalls: 2, maxIdenticalCalls: 2 });
  const first = budget.tryConsume({ runId: 'run-1', toolName: 'document.parse', inputHash: 'a' });
  const second = budget.tryConsume({ runId: 'run-1', toolName: 'document.parse', inputHash: 'b' });
  const third = budget.tryConsume({ runId: 'run-1', toolName: 'document.parse', inputHash: 'c' });

  assert.deepEqual(first, { allowed: true });
  assert.deepEqual(second, { allowed: true });
  assert.equal(third.allowed, false);
  if (!third.allowed) assert.equal(third.code, 'STEP_BUDGET_EXCEEDED');
});

test('重复的工具指纹会被阻断，但不同 run 不会相互污染', () => {
  const budget = new InMemoryExecutionBudget({ maxToolCalls: 10, maxIdenticalCalls: 2 });
  const attempt = { toolName: 'shell.execute', inputHash: 'git-status' };

  assert.equal(budget.tryConsume({ runId: 'run-1', ...attempt }).allowed, true);
  assert.equal(budget.tryConsume({ runId: 'run-1', ...attempt }).allowed, true);
  const blocked = budget.tryConsume({ runId: 'run-1', ...attempt });
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.code, 'REPEATED_TOOL_CALL');
  assert.equal(budget.tryConsume({ runId: 'run-2', ...attempt }).allowed, true);
});

test('预算配置拒绝零或负数阈值', () => {
  assert.throws(() => new InMemoryExecutionBudget({ maxToolCalls: 0 }), /正整数/);
  assert.throws(() => new InMemoryExecutionBudget({ maxIdenticalCalls: -1 }), /正整数/);
});
