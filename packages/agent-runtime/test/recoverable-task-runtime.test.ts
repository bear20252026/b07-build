import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityPolicyRule, TaskEvent } from '@awo/protocol';
import {
  InMemoryApprovalPort,
  InMemoryTaskSnapshotStore,
  RecoverableTaskRuntime,
  RuleBasedCapabilityPolicy,
  type DAGNode,
  type ToolRunner,
} from '../src/index.js';

const policies: CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: 'baseline read' },
  { capability: 'filesystem.write', decision: 'allow', reason: 'baseline write' },
  { capability: 'model.chat', decision: 'allow', reason: 'baseline model' },
  { capability: 'network.fetch', decision: 'allow', reason: 'baseline network' },
  { capability: 'shell.execute', decision: 'allow', reason: 'baseline shell' },
  { capability: 'browser.control', decision: 'allow', reason: 'baseline browser' },
];

const nodes: DAGNode[] = [
  {
    id: 'parse',
    kind: 'tool',
    tool: { name: 'document.parse', args: { path: 'brief.md' }, capability: 'document.parse', risk: 'low' },
    deps: [],
  },
  {
    id: 'write',
    kind: 'tool',
    tool: { name: 'filesystem.write', args: { path: 'plan.md' }, capability: 'filesystem.write', risk: 'low' },
    deps: ['parse'],
  },
];

class TrackingRunner implements ToolRunner {
  readonly calls: string[] = [];

  async run(node: DAGNode): Promise<{ ok: boolean; outputRef: string }> {
    this.calls.push(node.id);
    return { ok: true, outputRef: `artifact://${node.id}` };
  }
}

test('Build 任务在审批缺失时保存可恢复快照，并在批准后仅重跑未完成节点', async () => {
  const snapshots = new InMemoryTaskSnapshotStore();
  const events: TaskEvent[] = [];
  const initialRunner = new TrackingRunner();
  const baseRequest = {
    taskId: 'task-local',
    runId: 'run-local',
    profileId: 'build' as const,
    nodes,
    baselinePolicy: new RuleBasedCapabilityPolicy(policies),
    emit: (event: TaskEvent) => events.push(event),
    now: () => 100,
  };

  const initial = await new RecoverableTaskRuntime(
    { ...baseRequest, approvals: new InMemoryApprovalPort(), runner: initialRunner },
    snapshots,
  ).run();

  assert.equal(initial.status, 'blocked');
  assert.deepEqual(initial.nodeOutcomes, { parse: 'ok', write: 'blocked' });
  assert.deepEqual(initialRunner.calls, ['parse']);
  assert.equal(events.filter((event) => event.type === 'tool.called').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool.result').length, 2);
  assert.equal(events.filter((event) => event.type === 'approval.required').length, 1);

  const resumedRunner = new TrackingRunner();
  const resumed = await new RecoverableTaskRuntime(
    {
      ...baseRequest,
      approvals: new InMemoryApprovalPort(new Set(['run-local:write'])),
      runner: resumedRunner,
    },
    snapshots,
  ).run();

  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.nodeOutcomes, { parse: 'ok', write: 'ok' });
  assert.equal(resumed.attempt, 2);
  assert.deepEqual(resumedRunner.calls, ['write']);
  assert.equal(resumed.stats?.startedNodes, 1);
  assert.equal(resumed.stats?.completedNodes, 2);
});

test('Plan Profile 的拒绝会在快照中保留 failed 终态，而不会触达底层工具', async () => {
  const snapshots = new InMemoryTaskSnapshotStore();
  const runner = new TrackingRunner();
  const snapshot = await new RecoverableTaskRuntime(
    {
      taskId: 'task-plan',
      runId: 'run-plan',
      profileId: 'plan',
      nodes: [{ ...nodes[1], deps: [] }],
      baselinePolicy: new RuleBasedCapabilityPolicy(policies),
      approvals: new InMemoryApprovalPort(new Set(['run-plan:write'])),
      runner,
      emit: () => undefined,
      now: () => 200,
    },
    snapshots,
  ).run();

  assert.equal(snapshot.status, 'failed');
  assert.deepEqual(snapshot.nodeOutcomes, { write: 'failed' });
  assert.deepEqual(runner.calls, []);
});
