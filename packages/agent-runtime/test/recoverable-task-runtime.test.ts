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

test('Authority Mode 将 plan 收紧为只读，并允许 automate 在既有 Profile 边界内免除逐步审批', async () => {
  const planRunner = new TrackingRunner();
  const planSnapshot = await new RecoverableTaskRuntime({
    taskId: 'task-authority-plan', runId: 'run-authority-plan', profileId: 'build', authorityMode: 'plan', nodes: [{ ...nodes[1], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: planRunner, emit: () => undefined, now: () => 300,
  }, new InMemoryTaskSnapshotStore()).run();
  assert.equal(planSnapshot.status, 'failed');
  assert.deepEqual(planRunner.calls, []);

  const automateRunner = new TrackingRunner();
  const automateSnapshot = await new RecoverableTaskRuntime({
    taskId: 'task-authority-auto', runId: 'run-authority-auto', profileId: 'build', authorityMode: 'automate', nodes: [{ ...nodes[1], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: automateRunner, emit: () => undefined, now: () => 301,
  }, new InMemoryTaskSnapshotStore()).run();
  assert.equal(automateSnapshot.status, 'completed');
  assert.equal(automateSnapshot.authorityMode, 'automate');
  assert.deepEqual(automateRunner.calls, ['write']);
});

test('恢复任务锁定原始 Authority Mode，拒绝通过 resume 提升权限', async () => {
  const snapshots = new InMemoryTaskSnapshotStore();
  await new RecoverableTaskRuntime({
    taskId: 'task-authority-resume', runId: 'run-authority-resume', profileId: 'build', authorityMode: 'review', nodes: [{ ...nodes[1], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: new TrackingRunner(), emit: () => undefined, now: () => 400,
  }, snapshots).run();
  await assert.rejects(() => new RecoverableTaskRuntime({
    taskId: 'task-authority-resume', runId: 'run-authority-resume', profileId: 'build', authorityMode: 'automate', nodes: [{ ...nodes[1], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: new TrackingRunner(), emit: () => undefined, now: () => 401,
  }, snapshots).run(), /不得变更/);
});


test('外部 provenance 会在 automate 下阻断写入，Reader Profile 也不能触发外部副作用', async () => {
  const taintedRunner = new TrackingRunner();
  const inputProvenance = [{ schemaVersion: 1 as const, inputId: 'web-brief-1', trust: 'external-untrusted' as const, sourceKind: 'web' as const, contentDigest: 'a'.repeat(64) }];
  const tainted = await new RecoverableTaskRuntime({
    taskId: 'task-tainted', runId: 'run-tainted', profileId: 'build', authorityMode: 'automate', inputProvenance, nodes: [{ ...nodes[1], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: taintedRunner, emit: () => undefined, now: () => 500,
  }, new InMemoryTaskSnapshotStore()).run();
  assert.equal(tainted.status, 'failed');
  assert.deepEqual(taintedRunner.calls, []);
  assert.equal(tainted.inputProvenance?.[0].trust, 'external-untrusted');

  const readerRunner = new TrackingRunner();
  const reader = await new RecoverableTaskRuntime({
    taskId: 'task-reader', runId: 'run-reader', profileId: 'reader', authorityMode: 'automate', inputProvenance, nodes: [{ ...nodes[1], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: readerRunner, emit: () => undefined, now: () => 501,
  }, new InMemoryTaskSnapshotStore()).run();
  assert.equal(reader.status, 'failed');
  assert.deepEqual(readerRunner.calls, []);
});

test('恢复任务锁定输入 provenance，拒绝通过 resume 偷换信任摘要', async () => {
  const snapshots = new InMemoryTaskSnapshotStore();
  const inputProvenance = [{ schemaVersion: 1 as const, inputId: 'web-brief-1', trust: 'external-untrusted' as const, sourceKind: 'web' as const, contentDigest: 'a'.repeat(64) }];
  await new RecoverableTaskRuntime({
    taskId: 'task-taint-resume', runId: 'run-taint-resume', profileId: 'reader', inputProvenance, nodes: [{ ...nodes[0], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: new TrackingRunner(), emit: () => undefined, now: () => 510,
  }, snapshots).run();
  await assert.rejects(() => new RecoverableTaskRuntime({
    taskId: 'task-taint-resume', runId: 'run-taint-resume', profileId: 'reader',
    inputProvenance: [{ ...inputProvenance[0], contentDigest: 'b'.repeat(64) }], nodes: [{ ...nodes[0], deps: [] }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policies), approvals: new InMemoryApprovalPort(), runner: new TrackingRunner(), emit: () => undefined, now: () => 511,
  }, snapshots).run(), /不得变更原始输入 provenance/);
});
