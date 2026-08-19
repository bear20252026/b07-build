import assert from 'node:assert/strict';
import test from 'node:test';
import { TASK_EVENT_PROTOCOL_VERSION } from '../src/types.js';
import { isTaskEvent, validateTaskEvent } from '../src/task-event-validator.js';

const base = {
  protocolVersion: TASK_EVENT_PROTOCOL_VERSION,
  eventId: 'evt-1',
  taskId: 'task-1',
  runId: 'run-1',
  at: 1,
};

test('接受拥有完整 envelope 的 task.created 事件', () => {
  const result = validateTaskEvent({
    ...base,
    type: 'task.created',
    goal: '提取本地文档并交付 Markdown 摘要',
  });

  assert.equal(result.ok, true);
  assert.equal(isTaskEvent(result.ok ? result.event : undefined), true);
});

test('拒绝缺少 runId 的事件，避免不可回放记录进入事件流', () => {
  const { runId: _runId, ...withoutRun } = base;
  const result = validateTaskEvent({
    ...withoutRun,
    type: 'task.created',
    goal: '不完整事件',
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.keyword === 'required'));
  }
});

test('拒绝未声明能力的工具调用，避免策略层收到任意字符串', () => {
  const result = validateTaskEvent({
    ...base,
    type: 'tool.called',
    callId: 'call-1',
    inputHash: 'hash-1',
    tool: {
      name: 'unknown-tool',
      args: {},
      capability: 'unbounded.root',
      risk: 'high',
    },
  });

  assert.equal(result.ok, false);
});


test('拒绝未在协议中声明的顶层字段，防止通道静默漂移', () => {
  const result = validateTaskEvent({
    ...base,
    type: 'task.created',
    goal: '严格契约事件',
    unreviewedField: true,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.keyword === 'unevaluatedProperties'));
  }
});


test('接受可回放的 Agent Profile 切换事件', () => {
  const result = validateTaskEvent({
    ...base,
    type: 'agent.profile.selected',
    profileId: 'plan',
  });

  assert.equal(result.ok, true);
});

test('拒绝未定义的 Agent Profile，避免 UI 选择脱离运行时策略', () => {
  const result = validateTaskEvent({
    ...base,
    type: 'agent.profile.selected',
    profileId: 'unbounded',
  });

  assert.equal(result.ok, false);
});
