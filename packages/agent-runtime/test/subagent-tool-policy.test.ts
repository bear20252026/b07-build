// 一个文件=一种作用：子代理工具面剔除（plan 工具等）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
  buildSubagentChildDisallowRules,
  filterSubagentChildToolNames,
  isSubagentChildToolDisallowed,
} from '../src/index.js';

test('plan 工具是任何子代理的强制禁用项', () => {
  assert.deepEqual([...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS], ['EnterPlanMode', 'ExitPlanMode']);
  assert.equal(ENTER_PLAN_MODE_TOOL_NAME, 'EnterPlanMode');
  assert.equal(EXIT_PLAN_MODE_TOOL_NAME, 'ExitPlanMode');
  assert.equal(isSubagentChildToolDisallowed('ExitPlanMode', undefined), true);
  assert.equal(isSubagentChildToolDisallowed('Read', undefined), false);
});

test('工具面过滤剔除 plan 工具，且不修改入参', () => {
  const tools = ['Read', 'EnterPlanMode', 'Bash', 'ExitPlanMode'];
  const filtered = filterSubagentChildToolNames(tools, undefined);
  assert.deepEqual(filtered, ['Read', 'Bash']);
  assert.deepEqual(tools, ['Read', 'EnterPlanMode', 'Bash', 'ExitPlanMode'], '入参保持原样');
  assert.notEqual(filtered, tools, '返回新数组');
});

test('profile 声明的 disallowedTools 与强制禁用项叠加', () => {
  assert.deepEqual(buildSubagentChildDisallowRules(['Bash']), ['EnterPlanMode', 'ExitPlanMode', 'Bash']);
  assert.deepEqual(filterSubagentChildToolNames(['Read', 'Bash', 'Glob'], ['Bash']), ['Read', 'Glob']);
  // 规则可带括号模式：取括号前的工具名。
  assert.deepEqual(filterSubagentChildToolNames(['Read', 'Write'], ['Write(*)']), ['Read']);
});

test('别名归一：web_search 与 WebSearch 视为同一工具', () => {
  assert.equal(isSubagentChildToolDisallowed('web_search', ['WebSearch']), true);
  assert.deepEqual(filterSubagentChildToolNames(['web_search', 'Read'], ['WebSearch']), ['Read']);
});
