import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityPolicyRule } from '@awo/protocol';
import {
  InMemoryApprovalPort,
  InMemoryTaskSnapshotStore,
  LocalTaskRuntimeService,
  RuleBasedCapabilityPolicy,
  type TaskRuntimeRequest,
  type ToolRunner,
} from '../src/index.js';

const policy: CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: 'read allowed' },
  { capability: 'model.chat', decision: 'allow', reason: 'model allowed' },
  { capability: 'filesystem.read', decision: 'allow', reason: 'read allowed' },
  { capability: 'filesystem.write', decision: 'allow', reason: 'write allowed' },
  { capability: 'network.fetch', decision: 'allow', reason: 'network allowed' },
  { capability: 'shell.execute', decision: 'allow', reason: 'shell allowed' },
  { capability: 'browser.control', decision: 'allow', reason: 'browser allowed' },
];

const runner: ToolRunner = {
  async run(node) {
    return { ok: true, outputRef: `artifact://${node.id}` };
  },
};

function request(overrides: Partial<TaskRuntimeRequest> = {}): TaskRuntimeRequest {
  return {
    taskId: 'task-service',
    runId: 'run-service',
    goal: '验证本地任务服务边界',
    profileId: 'plan',
    nodes: [{
      id: 'read',
      kind: 'tool',
      tool: { name: 'document.parse', args: {}, capability: 'document.parse', risk: 'low' },
      deps: [],
    }],
    baselinePolicy: new RuleBasedCapabilityPolicy(policy),
    approvals: new InMemoryApprovalPort(),
    runner,
    emit: () => undefined,
    now: () => 100,
    ...overrides,
  };
}

test('本地任务服务提交可验证任务并暴露最新快照', async () => {
  const service = new LocalTaskRuntimeService(new InMemoryTaskSnapshotStore());
  const snapshot = await service.submit(request());

  assert.equal(snapshot.status, 'completed');
  assert.equal(service.snapshot('task-service', 'run-service')?.status, 'completed');
});

test('本地任务服务拒绝没有快照或缺少目标/节点的恢复请求', async () => {
  const service = new LocalTaskRuntimeService(new InMemoryTaskSnapshotStore());
  await assert.rejects(service.resume(request()), /cannot resume missing run/);
  await assert.rejects(service.submit(request({ goal: '   ' })), /goal 不能为空/);
  await assert.rejects(service.submit(request({ nodes: [] })), /至少需要一个/);
});
