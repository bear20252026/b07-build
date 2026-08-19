import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityPolicyRule, TaskEvent } from '@awo/protocol';
import { RuleBasedCapabilityPolicy } from '../src/capability-policy.js';
import { InMemoryExecutionBudget, type ExecutionBudget } from '../src/execution-budget.js';
import {
  ControlledToolRunner,
  InMemoryApprovalPort,
  type ControlledToolRequest,
} from '../src/controlled-tool-runner.js';
import type { DAGNode, ToolRunner } from '../src/executor.js';

class RecordingRunner implements ToolRunner {
  calls = 0;

  async run(_node: DAGNode): Promise<{ ok: boolean; outputRef: string }> {
    this.calls += 1;
    return { ok: true, outputRef: 'artifact://document-summary' };
  }
}

function request(actionId: string): ControlledToolRequest {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    actionId,
    callId: `call-${actionId}`,
    inputHash: 'input-hash-1',
    tool: {
      name: 'document.parse',
      args: { path: '/local/brief.md' },
      capability: 'document.parse',
      risk: 'low',
    },
    at: 1,
  };
}

function createRunner(
  rules: readonly CapabilityPolicyRule[],
  approvals = new InMemoryApprovalPort(),
  budget?: ExecutionBudget,
): { controlled: ControlledToolRunner; events: TaskEvent[]; runner: RecordingRunner } {
  const events: TaskEvent[] = [];
  const runner = new RecordingRunner();
  return {
    controlled: new ControlledToolRunner(
      new RuleBasedCapabilityPolicy(rules),
      approvals,
      runner,
      (event) => events.push(event),
      budget,
    ),
    events,
    runner,
  };
}

test('未配置能力规则时默认拒绝，且不会触发底层工具', async () => {
  const { controlled, events, runner } = createRunner([]);
  const result = await controlled.run(request('deny-1'));

  assert.equal(result.errorCode, 'CAPABILITY_DENIED');
  assert.equal(runner.calls, 0);
  assert.deepEqual(events.map((event) => event.type), ['tool.result']);
});

test('需要审批而尚未批准时，只发审批事件并保持工具未执行', async () => {
  const { controlled, events, runner } = createRunner([
    {
      capability: 'document.parse',
      risk: 'low',
      decision: 'require_approval',
      reason: '首次读取文件需用户确认',
    },
  ]);
  const result = await controlled.run(request('approval-1'));

  assert.equal(result.errorCode, 'APPROVAL_REQUIRED');
  assert.equal(runner.calls, 0);
  assert.deepEqual(events.map((event) => event.type), [
    'approval.required',
    'tool.result',
  ]);
});

test('规则允许且审批已存在时才执行工具，并发射成对的调用与结果事件', async () => {
  const actionId = 'approved-1';
  const { controlled, events, runner } = createRunner(
    [
      {
        capability: 'document.parse',
        risk: 'low',
        decision: 'require_approval',
        reason: '首次读取文件需用户确认',
      },
    ],
    new InMemoryApprovalPort(new Set([actionId])),
  );
  const result = await controlled.run(request(actionId));

  assert.deepEqual(result, { status: 'ok', outputRef: 'artifact://document-summary' });
  assert.equal(runner.calls, 1);
  assert.deepEqual(events.map((event) => event.type), ['tool.called', 'tool.result']);
});


test('执行预算耗尽时发出阻断事件且不会再次触达底层工具', async () => {
  const rules: CapabilityPolicyRule[] = [
    {
      capability: 'document.parse',
      risk: 'low',
      decision: 'allow',
      reason: '本地文档解析已授权',
    },
  ];
  const { controlled, events, runner } = createRunner(
    rules,
    new InMemoryApprovalPort(),
    new InMemoryExecutionBudget({ maxToolCalls: 1, maxIdenticalCalls: 2 }),
  );

  await controlled.run(request('first-run'));
  const blocked = await controlled.run(request('second-run'));

  assert.equal(blocked.errorCode, 'STEP_BUDGET_EXCEEDED');
  assert.equal(runner.calls, 1);
  assert.deepEqual(events.slice(-2).map((event) => event.type), [
    'execution.blocked',
    'tool.result',
  ]);
});
