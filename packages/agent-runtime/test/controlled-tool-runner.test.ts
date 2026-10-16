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
import type { HookInvocation } from '../src/hook-contract.js';
import { HookRegistry } from '../src/hook-registry.js';

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

// ─────────────────── Hook 链接入（基线 1 的第四段） ───────────────────

/** 记录收到入参的 runner，用于断言 Hook 的改写真的传到了底层。 */
class InputRecordingRunner implements ToolRunner {
  readonly inputs: (Readonly<Record<string, unknown>> | undefined)[] = [];

  async run(node: DAGNode): Promise<{ ok: boolean; outputRef: string }> {
    this.inputs.push(node.input);
    return { ok: true, outputRef: 'artifact://ok' };
  }
}

function allowAllRules(): readonly CapabilityPolicyRule[] {
  return [{ capability: 'document.parse', risk: 'low', decision: 'allow', reason: '已授权' }];
}

test('未注入 Hook 选择器时行为与接入前一致', async () => {
  const events: TaskEvent[] = [];
  const runner = new InputRecordingRunner();
  const controlled = new ControlledToolRunner(
    new RuleBasedCapabilityPolicy(allowAllRules()),
    new InMemoryApprovalPort(),
    runner,
    (event) => events.push(event),
  );

  const result = await controlled.run(request('no-hooks'));
  assert.equal(result.status, 'ok');
  assert.equal(runner.inputs.length, 1);
  // 未提供 input 时底层收到 undefined，保持既有语义。
  assert.equal(runner.inputs[0], undefined);
  assert.deepEqual(events.map((e) => e.type), ['tool.called', 'tool.result']);
});

test('PreToolUse 的 Block 拦下调用且不扣预算、不触达底层', async () => {
  const events: TaskEvent[] = [];
  const runner = new InputRecordingRunner();
  const registry = new HookRegistry();
  registry.register({
    event: 'PreToolUse',
    id: 'deny-parse',
    handler: () => ({ kind: 'Block', reason: '解析被策略拦下' }),
  });

  const controlled = new ControlledToolRunner(
    new RuleBasedCapabilityPolicy(allowAllRules()),
    new InMemoryApprovalPort(),
    runner,
    (event) => events.push(event),
    new InMemoryExecutionBudget(),
    (event, toolName) => registry.matching(event, toolName),
  );

  const result = await controlled.run(request('blocked-call'));
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'HOOK_BLOCKED');
  assert.equal(result.reason, '解析被策略拦下');
  assert.equal(result.blocked, true);
  // 关键：被拦下的调用绝不触达底层工具。
  assert.equal(runner.inputs.length, 0);
  // 事件序列：不得出现 tool.called。
  assert.deepEqual(events.map((e) => e.type), ['tool.result']);
});

test('PreToolUse 的 Modify 改写真正传到 ToolRunner', async () => {
  const runner = new InputRecordingRunner();
  const registry = new HookRegistry();
  registry.register({
    event: 'PreToolUse',
    id: 'rewrite-path',
    handler: () => ({ kind: 'Modify', updatedInput: { path: '/safe/brief.md' } }),
  });

  const controlled = new ControlledToolRunner(
    new RuleBasedCapabilityPolicy(allowAllRules()),
    new InMemoryApprovalPort(),
    runner,
    () => {},
    new InMemoryExecutionBudget(),
    (event, toolName) => registry.matching(event, toolName),
  );

  const withInput: ControlledToolRequest = { ...request('modify-call'), input: { path: '/etc/shadow' } };
  const result = await controlled.run(withInput);

  assert.equal(result.status, 'ok');
  // 这是整个 Hook 链的价值所在：改写必须生效，否则 Modify 只是摆设。
  assert.deepEqual(runner.inputs[0], { path: '/safe/brief.md' });
});

test('PostToolUse 在结果事件之前运行，且不改写结果', async () => {
  const events: TaskEvent[] = [];
  const runner = new InputRecordingRunner();
  const observed: boolean[] = [];
  const registry = new HookRegistry();
  registry.register({
    event: 'PostToolUse',
    id: 'observe',
    handler: (invocation: HookInvocation) => {
      observed.push(invocation.toolSucceeded ?? false);
      // 即便 PostToolUse 或图 Block，也不得改变已发生的结果。
      return { kind: 'Block', reason: '太晚了' };
    },
  });

  const controlled = new ControlledToolRunner(
    new RuleBasedCapabilityPolicy(allowAllRules()),
    new InMemoryApprovalPort(),
    runner,
    (event) => events.push(event),
    new InMemoryExecutionBudget(),
    (event, toolName) => registry.matching(event, toolName),
  );

  const result = await controlled.run({ ...request('post-call'), input: { path: '/a' } });

  assert.equal(result.status, 'ok', 'PostToolUse 的 Block 不得改变结果');
  assert.deepEqual(observed, [true]);
  // 事件顺序：tool.called → tool.result（Hook 在两者之间，不产生事件）。
  assert.deepEqual(events.map((e) => e.type), ['tool.called', 'tool.result']);
});

test('Hook 条件按工具名筛选，不匹配的 Hook 不执行', async () => {
  const runner = new InputRecordingRunner();
  const registry = new HookRegistry();
  let ran = false;
  registry.register({
    event: 'PreToolUse',
    id: 'only-mcp',
    when: 'Tool(mcp__*)',
    handler: () => {
      ran = true;
      return { kind: 'Block', reason: '不该跑到' };
    },
  });

  const controlled = new ControlledToolRunner(
    new RuleBasedCapabilityPolicy(allowAllRules()),
    new InMemoryApprovalPort(),
    runner,
    () => {},
    new InMemoryExecutionBudget(),
    (event, toolName) => registry.matching(event, toolName),
  );

  // 本请求的工具是 document.parse，不匹配 mcp__*。
  const result = await controlled.run(request('non-matching'));
  assert.equal(result.status, 'ok');
  assert.equal(ran, false);
});
