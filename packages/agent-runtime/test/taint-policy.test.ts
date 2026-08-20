import { strict as assert } from 'node:assert';
import test from 'node:test';
import { RuleBasedCapabilityPolicy, TaintAwareCapabilityPolicy } from '../src/index.js';

const digest = 'a'.repeat(64);
const external = { schemaVersion: 1 as const, inputId: 'input-web-1', trust: 'external-untrusted' as const, sourceKind: 'web' as const, contentDigest: digest };

function request(capability: import('@awo/protocol').Capability) {
  return { capability, risk: 'medium' as const, taskId: 'task-1', runId: 'run-1', actionId: `action-${capability}` };
}

const permissive = new RuleBasedCapabilityPolicy([
  { capability: 'document.parse', decision: 'allow', reason: 'test allow' },
  { capability: 'model.chat', decision: 'allow', reason: 'test allow' },
  { capability: 'filesystem.read', decision: 'allow', reason: 'test allow' },
  { capability: 'filesystem.write', decision: 'allow', reason: 'test allow' },
  { capability: 'network.fetch', decision: 'require_approval', reason: 'test approval' },
  { capability: 'shell.execute', decision: 'allow', reason: 'test allow' },
  { capability: 'browser.control', decision: 'allow', reason: 'test allow' },
]);

test('taint gate 对外部内容固定拒绝高影响能力，但不扩大只读能力', () => {
  const policy = new TaintAwareCapabilityPolicy([external], permissive);
  assert.equal(policy.isTainted(), true);
  for (const capability of ['filesystem.write', 'network.fetch', 'shell.execute', 'browser.control'] as const) {
    const evaluation = policy.evaluate(request(capability));
    assert.equal(evaluation.decision, 'deny');
    assert.match(evaluation.reason, /taint gate/);
  }
  assert.equal(policy.evaluate(request('document.parse')).decision, 'allow');
  assert.equal(policy.evaluate(request('model.chat')).decision, 'allow');
  assert.equal(policy.evaluate(request('filesystem.read')).decision, 'allow');
});

test('taint gate 保留下游 deny，并在纯可信来源任务中不改变既有决议', () => {
  const baselineDeny = new RuleBasedCapabilityPolicy([
    { capability: 'shell.execute', decision: 'deny', reason: 'lower policy deny' },
  ]);
  const tainted = new TaintAwareCapabilityPolicy([external], baselineDeny);
  assert.deepEqual(tainted.evaluate(request('shell.execute')), { decision: 'deny', reason: 'lower policy deny' });
  const trusted = new TaintAwareCapabilityPolicy([
    { schemaVersion: 1, inputId: 'input-local-1', trust: 'operator-authored', sourceKind: 'operator', contentDigest: digest },
  ], permissive);
  assert.equal(trusted.isTainted(), false);
  assert.equal(trusted.evaluate(request('filesystem.write')).decision, 'allow');
});

test('taint provenance 归一化拒绝来源不匹配和重复 ID，并防御性复制状态', () => {
  assert.throws(() => new TaintAwareCapabilityPolicy([
    { ...external, trust: 'external-untrusted', sourceKind: 'operator' },
  ], permissive), /来源不被允许/);
  assert.throws(() => new TaintAwareCapabilityPolicy([external, { ...external }], permissive), /重复/);
  const policy = new TaintAwareCapabilityPolicy([external], permissive);
  const view = policy.listInputProvenance();
  (view[0] as { inputId: string }).inputId = 'mutated';
  assert.equal(policy.listInputProvenance()[0].inputId, 'input-web-1');
});
