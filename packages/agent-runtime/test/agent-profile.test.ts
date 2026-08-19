import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityPolicyRule, CapabilityRequest } from '@awo/protocol';
import {
  AGENT_PROFILES,
  ProfiledCapabilityPolicy,
  RuleBasedCapabilityPolicy,
} from '../src/index.js';

const request = (capability: CapabilityRequest['capability']): CapabilityRequest => ({
  capability,
  risk: 'low',
  taskId: 'profile-task',
  runId: 'profile-run',
  actionId: `action-${capability}`,
});

const permissiveRules: CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: 'baseline allow' },
  { capability: 'model.chat', decision: 'allow', reason: 'baseline allow' },
  { capability: 'filesystem.read', decision: 'allow', reason: 'baseline allow' },
  { capability: 'filesystem.write', decision: 'allow', reason: 'baseline allow' },
  { capability: 'network.fetch', decision: 'allow', reason: 'baseline allow' },
  { capability: 'shell.execute', decision: 'allow', reason: 'baseline allow' },
  { capability: 'browser.control', decision: 'allow', reason: 'baseline allow' },
];

test('Plan Profile 会收紧宽松基线，禁止写入和 Shell', () => {
  const policy = new ProfiledCapabilityPolicy(
    AGENT_PROFILES.plan,
    new RuleBasedCapabilityPolicy(permissiveRules),
  );

  assert.equal(policy.evaluate(request('filesystem.read')).decision, 'allow');
  assert.equal(policy.evaluate(request('filesystem.write')).decision, 'deny');
  assert.equal(policy.evaluate(request('shell.execute')).decision, 'deny');
});

test('Build Profile 允许实现路径，但要求高影响工具先审批', () => {
  const policy = new ProfiledCapabilityPolicy(
    AGENT_PROFILES.build,
    new RuleBasedCapabilityPolicy(permissiveRules),
  );

  assert.equal(policy.evaluate(request('filesystem.write')).decision, 'require_approval');
  assert.equal(policy.evaluate(request('network.fetch')).decision, 'require_approval');
  assert.equal(policy.evaluate(request('model.chat')).decision, 'allow');
});

test('Profile 无法突破基线拒绝，限制只能单向加严', () => {
  const baseline = new RuleBasedCapabilityPolicy([
    ...permissiveRules.filter((rule) => rule.capability !== 'filesystem.read'),
    { capability: 'filesystem.read', decision: 'deny', reason: 'baseline deny' },
  ]);
  const policy = new ProfiledCapabilityPolicy(AGENT_PROFILES.explore, baseline);

  const evaluation = policy.evaluate(request('filesystem.read'));
  assert.equal(evaluation.decision, 'deny');
  assert.equal(evaluation.reason, 'baseline deny');
});

test('Explore Profile 限制工具和上下文预算，适合只读快速检索', () => {
  const profile = AGENT_PROFILES.explore;
  assert.equal(profile.maxToolCalls, 10);
  assert.equal(profile.maxIdenticalCalls, 1);
  assert.equal(profile.contextMaxTokens, 8_000);
});
