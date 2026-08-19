import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  AdministratorAuthorityLedger,
  AuthorityCapabilityPolicy,
  InMemoryAdministratorLeaseStore,
  RuleBasedCapabilityPolicy,
} from '../src/index.js';

const digest = createHash('sha256').update('scheduled local maintenance').digest('hex');
const request = { capability: 'shell.execute' as const, risk: 'high' as const, taskId: 'task-1', runId: 'run-1', actionId: 'run-1:shell' };
const base = new RuleBasedCapabilityPolicy([
  { capability: 'filesystem.read', decision: 'allow', reason: 'read allowed' },
  { capability: 'shell.execute', decision: 'require_approval', reason: 'shell needs approval' },
  { capability: 'browser.control', decision: 'deny', reason: 'browser denied' },
]);

test('四级 Authority Mode 只能收紧或在合法 scope 内免除审批，绝不覆盖 deny', () => {
  const now = () => 100;
  assert.equal(new AuthorityCapabilityPolicy('review', base, undefined, now).evaluate(request).decision, 'require_approval');
  assert.equal(new AuthorityCapabilityPolicy('plan', base, undefined, now).evaluate(request).decision, 'deny');
  assert.equal(new AuthorityCapabilityPolicy('automate', base, undefined, now).evaluate(request).decision, 'allow');
  assert.equal(new AuthorityCapabilityPolicy('admin', base, undefined, now).evaluate(request).decision, 'deny');
  assert.equal(new AuthorityCapabilityPolicy('automate', base, undefined, now).evaluate({ ...request, capability: 'browser.control' }).decision, 'deny');
});

test('管理员租约严格绑定 task/run/capability、过期与撤销，并且不保存可变数组', () => {
  let at = 1_000;
  const ledger = new AdministratorAuthorityLedger(new InMemoryAdministratorLeaseStore(), () => at);
  const lease = ledger.issue({
    leaseId: 'lease-1', operatorId: 'owner-local', taskId: 'task-1', runId: 'run-1',
    allowedCapabilities: ['shell.execute'], issuedAt: at, expiresAt: at + 60_000, reasonDigest: digest,
  });
  (lease.allowedCapabilities as string[]).push('browser.control');
  const policy = new AuthorityCapabilityPolicy('admin', base, ledger, () => at);
  assert.equal(policy.evaluate(request).decision, 'allow');
  assert.equal(policy.evaluate({ ...request, capability: 'browser.control' }).decision, 'deny');
  at += 60_000;
  assert.equal(policy.evaluate(request).decision, 'deny');

  at = 62_000;
  ledger.issue({
    leaseId: 'lease-2', operatorId: 'owner-local', taskId: 'task-1', runId: 'run-1',
    allowedCapabilities: ['shell.execute'], issuedAt: at, expiresAt: at + 60_000, reasonDigest: digest,
  });
  assert.equal(policy.evaluate(request).decision, 'allow');
  ledger.revoke('lease-2', 'owner-local', at + 1);
  assert.equal(policy.evaluate(request).decision, 'deny');
});

test('管理员租约拒绝超长、空 capability、错误操作者与非摘要输入', () => {
  const ledger = new AdministratorAuthorityLedger(new InMemoryAdministratorLeaseStore(), () => 0);
  assert.throws(() => ledger.issue({ leaseId: 'bad', operatorId: 'owner', taskId: 'task', runId: 'run', allowedCapabilities: [], issuedAt: 0, expiresAt: 1, reasonDigest: digest }));
  assert.throws(() => ledger.issue({ leaseId: 'bad2', operatorId: 'owner', taskId: 'task', runId: 'run', allowedCapabilities: ['shell.execute'], issuedAt: 0, expiresAt: 900_001, reasonDigest: digest }));
  assert.throws(() => ledger.issue({ leaseId: 'bad3', operatorId: 'owner', taskId: 'task', runId: 'run', allowedCapabilities: ['shell.execute'], issuedAt: 0, expiresAt: 1, reasonDigest: 'not-a-digest' }));
});
