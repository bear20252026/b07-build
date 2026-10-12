// 一个文件=一种作用：ZCode 会话事件投影器的验收测试。
// 事件形状对齐 ZCode packages/shared/src/zcode-protocol 的 strict schema
// （envelope 携带 type，payload 为该类型的载荷，与 adapter 的 forward() 输出一致）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { initialZcodeSessionProjection, reduceZcodeSessionEvents, reduceZcodeSessionEvent } from '../src/runtime/zcode/zcode-session-projector';
import { reconcileAgentToolCallTree } from '../src/runtime/agent-tool-tree';
import type { ZCodeAgentEvent } from '../src/runtime/zcode/zcode-agent-adapter';

let seqCounter = 0;
function sessionEvent(type: string, payload: unknown, turnId?: string): ZCodeAgentEvent {
  seqCounter += 1;
  return {
    kind: 'event',
    method: 'session/event',
    envelope: { eventId: `evt-${seqCounter}`, sessionId: 's-1', seq: seqCounter, timestamp: 1_700_000_000_000, ...(turnId ? { turnId } : {}) },
    payload: { type, payload },
  };
}

test('文本流：part.delta 按字段累积，model.streaming 作为回退通道', () => {
  let state = reduceZcodeSessionEvents(initialZcodeSessionProjection, [
    sessionEvent('turn.started', { turnNumber: 1, input: 'hi' }, 'turn-1'),
    sessionEvent('part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: '你' }),
    sessionEvent('part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: '好' }),
    sessionEvent('part.delta', { messageId: 'm1', partId: 'p2', field: 'reasoning', delta: '思考中' }),
  ]);
  assert.equal(state.turnActive, true);
  assert.equal(state.turnId, 'turn-1');
  assert.equal(state.text, '你好');
  assert.equal(state.reasoning, '思考中');

  state = reduceZcodeSessionEvent(state, sessionEvent('model.streaming', { kind: 'text_delta', delta: '！' }));
  assert.equal(state.text, '你好！');
});

test('工具调用：scheduled/started/result/error 事件维护状态与输出，父子关系保留', () => {
  const state = reduceZcodeSessionEvents(initialZcodeSessionProjection, [
    sessionEvent('turn.started', { turnNumber: 1, input: 'hi' }, 'turn-1'),
    sessionEvent('tool.updated', { kind: 'scheduled', toolCallId: 't1', toolName: 'agent_run', description: '跑子任务', input: { goal: 'x' } }),
    sessionEvent('tool.updated', { kind: 'scheduled', toolCallId: 't1-1', toolName: 'workspace_read_file', parentToolCallId: 't1' }),
    sessionEvent('tool.updated', { kind: 'started', toolCallId: 't1', startedAt: 1234 }),
    sessionEvent('tool.updated', { kind: 'result', toolCallId: 't1-1', duration: 5, result: { content: '文件内容' } }),
    sessionEvent('tool.updated', { kind: 'error', toolCallId: 't1', error: { type: 'tool', message: '子任务失败' } }),
  ]);
  assert.deepEqual(
    state.toolCalls.map((call) => [call.toolId, call.status]),
    [['t1', 'failed'], ['t1-1', 'completed']],
  );
  const t1 = state.toolCalls[0]!;
  assert.equal(t1.toolName, 'agent_run');
  assert.equal(t1.title, '跑子任务');
  assert.equal(t1.startedAt, 1234);
  assert.equal(t1.error, '子任务失败');
  assert.deepEqual(t1.input, { goal: 'x' });
  const t1_1 = state.toolCalls[1]!;
  assert.equal(t1_1.parentToolUseId, 't1');
  assert.deepEqual(t1_1.output, { content: '文件内容' });
  // 投影记录可直接喂层级树。
  assert.equal(reconcileAgentToolCallTree(state.toolCalls).length, 1);
});

test('turn.completed / turn.failed 给出明确终态；turn.started 开启新回合时清空上一轮文本', () => {
  let state = reduceZcodeSessionEvents(initialZcodeSessionProjection, [
    sessionEvent('turn.started', { turnNumber: 1, input: 'hi' }, 'turn-1'),
    sessionEvent('part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: '回答' }),
    sessionEvent('tool.updated', { kind: 'scheduled', toolCallId: 't1', toolName: 'x' }),
    sessionEvent('turn.completed', { response: '最终回答', tokenCount: 42, toolCallCount: 1, duration: 100, resultType: 'success' }),
  ]);
  assert.equal(state.turnActive, false);
  assert.equal(state.text, '最终回答');
  assert.deepEqual(state.lastTurn, { completed: true, failed: false, resultType: 'success', tokenCount: 42 });

  const nextTurn = reduceZcodeSessionEvent(state, sessionEvent('turn.started', { turnNumber: 2, input: '再问' }, 'turn-2'));
  assert.equal(nextTurn.turnActive, true);
  assert.equal(nextTurn.text, '');
  assert.equal(nextTurn.toolCalls.length, 0, '新回合从空白开始，上一轮工具记录不残留');

  const failed = reduceZcodeSessionEvent(nextTurn, sessionEvent('turn.failed', { error: { type: 'api', message: '上游 429' }, turnPhase: 'model' }));
  assert.equal(failed.turnActive, false);
  assert.deepEqual(failed.lastTurn, { completed: false, failed: true, error: '上游 429' });
});

test('未知事件类型与非信封通知被忽略；缺口乱序由 adapter 水位负责，投影器只认有序流', () => {
  const state = reduceZcodeSessionEvents(initialZcodeSessionProjection, [
    sessionEvent('checkpoint.created', { checkpointId: 'c1' }),
    { kind: 'notification', method: 'state.updated', payload: { projection: {} } },
    sessionEvent('session.created', { mode: 'build', contextWindow: 200000 }),
  ]);
  assert.deepEqual(state, initialZcodeSessionProjection);
});
