// 一个文件=一种作用：权限决策链、规则匹配与人工裁决 broker 的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityPolicyRule, CapabilityRequest } from '@awo/protocol';
import {
  evaluatePermission,
  permissionChainPolicy,
  globToRegExp,
  matchesDomain,
  matchesPattern,
  ruleMatches,
} from '../src/permission-chain';
import { DenyPermissionBroker, ManualPermissionBroker } from '../src/permission-broker';
import { RuleBasedCapabilityPolicy } from '../src/capability-policy';

function request(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    capability: 'filesystem.write',
    risk: 'medium',
    taskId: 'task-1',
    runId: 'run-1',
    actionId: 'action-1',
    ...overrides,
  };
}

function rule(overrides: Partial<CapabilityPolicyRule>): CapabilityPolicyRule {
  return { capability: 'filesystem.write', decision: 'allow', reason: 'test-rule', ...overrides };
}

test('规则层：deny 先于 allow（同特异度）', () => {
  const evaluation = evaluatePermission(request(), {
    authorityMode: 'automate',
    rules: [
      rule({ decision: 'allow', ruleId: 'allow-write' }),
      rule({ decision: 'deny', ruleId: 'deny-write', reason: '显式拒绝写入' }),
    ],
  });
  assert.equal(evaluation.decision, 'deny');
  assert.equal(evaluation.ruleId, 'deny-write');
});

test('规则层：特异度顺序——模式规则 > 精确规则 > 能力级规则', () => {
  const rules: CapabilityPolicyRule[] = [
    rule({ decision: 'allow', reason: '能力级通配' }),
    rule({ decision: 'require_approval', risk: 'medium', ruleId: 'exact-medium' }),
    rule({ decision: 'deny', risk: 'medium', ruleId: 'exact-deny', reason: 'medium 一律拒' }),
    rule({
      decision: 'allow',
      toolPattern: 'edit_*',
      patternInput: '/repo/**',
      ruleId: 'scoped-allow',
      reason: '仓库内编辑放行',
    }),
  ];
  // 模式规则命中：allow（即使同集里另有 exact deny）
  const scoped = evaluatePermission(request({ toolName: 'edit_note', patternInput: '/repo/a.md' }), {
    authorityMode: 'review',
    rules,
  });
  assert.equal(scoped.decision, 'allow');
  assert.equal(scoped.ruleId, 'scoped-allow');
  // 模式规则未命中（路径在仓库外）：落到 exact deny
  const outside = evaluatePermission(request({ toolName: 'edit_note', patternInput: '/etc/passwd' }), {
    authorityMode: 'review',
    rules,
  });
  assert.equal(outside.decision, 'deny');
  assert.equal(outside.ruleId, 'exact-deny');
  // 未带 patternInput 的请求不可能命中模式规则：落到 exact deny
  const noInput = evaluatePermission(request({ toolName: 'edit_note' }), { authorityMode: 'review', rules });
  assert.equal(noInput.decision, 'deny');
  assert.equal(noInput.ruleId, 'exact-deny');
});

test('规则层：risk 未指定的规则匹配全部风险等级', () => {
  const evaluation = evaluatePermission(request({ risk: 'high' }), {
    authorityMode: 'automate',
    rules: [rule({ decision: 'require_approval', ruleId: 'ask-all' })],
  });
  assert.equal(evaluation.decision, 'require_approval');
  assert.equal(evaluation.ruleId, 'ask-all');
});

test('姿态兜底：plan 只放行只读能力；review/automate 保留 high 人工批准；admin 放行入审计', () => {
  const planRead = evaluatePermission(request({ capability: 'filesystem.read', risk: 'low' }), { authorityMode: 'plan', rules: [] });
  assert.equal(planRead.decision, 'allow');
  const planWrite = evaluatePermission(request(), { authorityMode: 'plan', rules: [] });
  assert.equal(planWrite.decision, 'deny');
  const reviewHigh = evaluatePermission(request({ risk: 'high' }), { authorityMode: 'review', rules: [] });
  assert.equal(reviewHigh.decision, 'require_approval');
  const automateHigh = evaluatePermission(request({ risk: 'high' }), { authorityMode: 'automate', rules: [] });
  assert.equal(automateHigh.decision, 'require_approval');
  const automateMedium = evaluatePermission(request(), { authorityMode: 'automate', rules: [] });
  assert.equal(automateMedium.decision, 'allow');
  const admin = evaluatePermission(request({ risk: 'high' }), { authorityMode: 'admin', rules: [] });
  assert.equal(admin.decision, 'allow');
  assert.match(admin.reason, /审计/);
});

test('姿态兜底：automate 对 medium 有结论；未知姿态 fail-closed 拒绝', () => {
  const evaluation = evaluatePermission(request(), {
    authorityMode: 'automate',
    rules: [],
    readOnlyCapabilities: [],
  });
  assert.equal(evaluation.decision, 'allow', 'automate 对 medium 有兜底结论');
  const unknown = evaluatePermission(request(), {
    authorityMode: 'wat' as 'automate',
    rules: [],
  });
  assert.equal(unknown.decision, 'deny');
});

test('通配与域名匹配', () => {
  assert.equal(globToRegExp('/repo/*').test('/repo/a.md'), true);
  assert.equal(globToRegExp('/repo/*').test('/repo/sub/a.md'), false);
  assert.equal(globToRegExp('/repo/**').test('/repo/sub/a.md'), true);
  assert.equal(matchesPattern('anything', undefined), true);
  assert.equal(matchesDomain('api.example.com', 'example.com'), false);
  assert.equal(matchesDomain('example.com', 'example.com'), true);
  assert.equal(matchesDomain('api.example.com', '*.example.com'), true);
  assert.equal(matchesDomain('a.b.example.com', '*.example.com'), false);
  assert.equal(matchesDomain('anything', undefined), true);
});

test('ruleMatches：能力/风险/工具名/作用对象四维过滤', () => {
  const base = request({ capability: 'network.fetch', toolName: 'webfetch', patternInput: 'api.example.com' });
  assert.equal(ruleMatches(rule({ capability: 'network.fetch' }), base), true);
  assert.equal(ruleMatches(rule({ capability: 'network.fetch', risk: 'high' }), base), false);
  assert.equal(ruleMatches(rule({ capability: 'network.fetch', toolPattern: 'web*' }), base), true);
  assert.equal(ruleMatches(rule({ capability: 'network.fetch', toolPattern: 'bash' }), base), false);
  assert.equal(
    ruleMatches(rule({ capability: 'network.fetch', patternInputKind: 'domain', patternInput: '*.example.com' }), base),
    true,
  );
  // 请求缺 toolName 时，声明了 toolPattern 的规则不可能命中
  assert.equal(ruleMatches(rule({ capability: 'network.fetch', toolPattern: 'web*' }), request({ capability: 'network.fetch' })), false);
});

test('permissionChainPolicy：包装为 CapabilityPolicy 即插即用', () => {
  const policy = permissionChainPolicy({ authorityMode: 'review', rules: [rule({ decision: 'deny', ruleId: 'no-write' })] });
  const evaluation = policy.evaluate(request());
  assert.equal(evaluation.decision, 'deny');
  assert.equal(evaluation.ruleId, 'no-write');
});

test('RuleBasedCapabilityPolicy：模式规则 + ruleId，缺规则默认拒绝', () => {
  const policy = new RuleBasedCapabilityPolicy([
    rule({
      decision: 'allow',
      toolPattern: 'edit_*',
      patternInput: '/repo/**',
      ruleId: 'repo-edit',
    }),
  ]);
  const allowed = policy.evaluate(request({ toolName: 'edit_note', patternInput: '/repo/x.md' }));
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.ruleId, 'repo-edit');
  const denied = policy.evaluate(request({ toolName: 'edit_note', patternInput: '/elsewhere/x.md' }));
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /默认拒绝/);
});

test('broker：未装配人工入口 = 拒绝（fail-closed 缺省）', async () => {
  const broker = new DenyPermissionBroker();
  assert.equal(await broker.ask({ actionId: 'a', toolName: 't', capability: 'shell.execute', risk: 'high', reason: 'r', inputPreview: '' }), false);
});

test('ManualPermissionBroker：应答放行、超时拒绝、重复应答 no-op、denyAll 全拒', async () => {
  const broker = new ManualPermissionBroker({ pendingTimeoutMs: 50 });
  const question = { actionId: 'a1', toolName: 'edit_note', capability: 'filesystem.write' as const, risk: 'medium' as const, reason: 'r', inputPreview: '{}' };
  const asked = broker.ask(question);
  assert.equal(broker.pendingCount, 1);
  assert.equal(broker.respond('a1', true), true);
  assert.equal(await asked, true);
  assert.equal(broker.respond('a1', false), false, '重复应答 no-op');

  const timeoutAsk = broker.ask({ ...question, actionId: 'a2' });
  assert.equal(await timeoutAsk, false, '超时按拒绝');

  const deniedAll = broker.ask({ ...question, actionId: 'a3' });
  broker.denyAll();
  assert.equal(await deniedAll, false);
  assert.equal(broker.pendingCount, 0);
});

test('ManualPermissionBroker：同 actionId 重复入队与先到者共命运', async () => {
  const broker = new ManualPermissionBroker();
  const question = { actionId: 'dup', toolName: 't', capability: 'shell.execute' as const, risk: 'high' as const, reason: 'r', inputPreview: '' };
  const first = broker.ask(question);
  const second = broker.ask(question);
  assert.equal(broker.pendingCount, 1, '不产生第二条 pending');
  assert.equal(broker.respond('dup', true), true);
  assert.deepEqual([await first, await second], [true, true]);
});

test('ManualPermissionBroker：no-always-allow 缺省不记忆；session 持久化需显式开', async () => {
  const question = { actionId: 'x1', toolName: 'edit_note', capability: 'filesystem.write' as const, risk: 'medium' as const, reason: 'r', inputPreview: '' };
  const strict = new ManualPermissionBroker();
  void strict.ask(question);
  strict.respond('x1', true);
  const again = strict.ask({ ...question, actionId: 'x2' });
  assert.equal(strict.pendingCount, 1, '缺省 no-always-allow：下一次仍要问');
  strict.respond('x2', true);
  assert.equal(await again, true);

  const session = new ManualPermissionBroker({ persistence: 'session' });
  void session.ask(question);
  session.respond('x1', true);
  assert.equal(await session.ask({ ...question, actionId: 'x3' }), true, 'session 级记住后免问');
});
