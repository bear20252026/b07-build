// 一个文件=一种作用：Task / Agent 子代理工具声明与输出预算的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_TOOL_NAME,
  SUBAGENT_AGENT_RESULT_BUDGET_CHARS,
  SUBAGENT_TASK_RESULT_BUDGET_CHARS,
  TASK_TOOL_NAME,
  applySubagentResultBudget,
  createSubagentTaskToolDescriptor,
  createSubagentToolRegistry,
} from '../src/index.js';

test('Task / Agent 描述符复用 protocol 契约并声明输出预算', () => {
  const registry = createSubagentToolRegistry();
  const task = registry.require(TASK_TOOL_NAME);
  const agent = registry.require(AGENT_TOOL_NAME);
  assert.equal(task.readOnly, true);
  assert.equal(task.sideEffectScope, 'none');
  assert.equal(task.capability, 'model.chat');
  assert.equal(task.resultBudgetChars, SUBAGENT_TASK_RESULT_BUDGET_CHARS);
  assert.equal(agent.readOnly, false);
  assert.equal(agent.sideEffectScope, 'workspace');
  assert.equal(agent.resultBudgetChars, SUBAGENT_AGENT_RESULT_BUDGET_CHARS);
  assert.ok(agent.timeoutMs >= task.timeoutMs);
  assert.deepEqual(registry.descriptors().map((item) => item.name).sort(), ['Agent', 'Task']);
});

test('结果预算内原样放行，超限则裁剪到硬上限', () => {
  const descriptor = createSubagentTaskToolDescriptor();
  const under = applySubagentResultBudget('短结果', descriptor);
  assert.deepEqual(under, { text: '短结果', truncated: false, originalChars: 3 });

  const oversized = 'x'.repeat(SUBAGENT_TASK_RESULT_BUDGET_CHARS + 100);
  const outcome = applySubagentResultBudget(oversized, descriptor);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.originalChars, oversized.length);
  assert.ok(outcome.text.length <= SUBAGENT_TASK_RESULT_BUDGET_CHARS);
  assert.match(outcome.text, /已截断/u);
});

test('非法预算描述符直接拒绝', () => {
  const descriptor = { ...createSubagentTaskToolDescriptor(), resultBudgetChars: 0 };
  assert.throws(() => applySubagentResultBudget('内容', descriptor), /resultBudgetChars/u);
});
