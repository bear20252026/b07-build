import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENCY_DIVISION_LABEL, loadAgencyRoles, toAgencyRole } from '../src/runtime/agency-role-catalog.js';

// ---------------------------------------------------------------------------
// 预置角色目录：构建期导出的数据，应用侧只读。
// ---------------------------------------------------------------------------

/** 一条合法的角色（用于逐项破坏）。 */
function validRole() {
  return {
    id: 'agency.example',
    division: 'engineering',
    displayName: 'Example',
    description: '示例角色。',
    content: '# Example\n\n正文',
    source: { upstreamUrl: 'https://example.com/x.md', license: 'MIT', copyright: 'Copyright (c) 2025 X' },
    canAutoInject: false,
    canAuthorize: false,
    canGrantCapabilities: false,
  };
}

test('内置目录能读出全部角色且没有丢弃', () => {
  const snapshot = loadAgencyRoles();
  assert.equal(snapshot.roles.length, 8);
  assert.equal(snapshot.dropped, 0, '生成产物应当是干净的');
  assert.equal(snapshot.license, 'MIT');
  assert.match(snapshot.copyright, /AgentLand Contributors/);
});

test('每个角色都有正文与上游来源', () => {
  // 正文为空会让"查看原文"变成空白；上游来源为空会让版权归因失效。
  for (const role of loadAgencyRoles().roles) {
    assert.ok(role.content.trim().length > 100, `${role.id} 正文过短`);
    assert.match(role.upstreamUrl, /^https:\/\//, `${role.id} 缺上游地址`);
    assert.equal(role.license, 'MIT');
  }
});

test('角色id不重复', () => {
  const ids = loadAgencyRoles().roles.map((role) => role.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('合法条目通过校验', () => {
  assert.deepEqual(toAgencyRole(validRole())?.id, 'agency.example');
});

test('非法分部被拒', () => {
  assert.equal(toAgencyRole({ ...validRole(), division: 'sales' }), undefined);
});

test('三个能力字段必须明确为false', () => {
  // 它们是"角色文本不授予能力"的机器可读保证。哪天上游把某个改成 true，
  // 说明语义变了 —— 那时应该显式改加载器，而不是让 true 悄悄流进界面。
  for (const field of ['canAutoInject', 'canAuthorize', 'canGrantCapabilities'] as const) {
    assert.equal(toAgencyRole({ ...validRole(), [field]: true }), undefined, `${field}=true 应被拒`);
    // 缺失同样拒绝：缺失说明生成侧没写，语义不明。
    const missing = validRole() as Record<string, unknown>;
    delete missing[field];
    assert.equal(toAgencyRole(missing), undefined, `${field} 缺失应被拒`);
  }
});

test('缺正文或来源被拒', () => {
  assert.equal(toAgencyRole({ ...validRole(), content: '' }), undefined);
  assert.equal(toAgencyRole({ ...validRole(), source: undefined }), undefined);
  assert.equal(toAgencyRole({ ...validRole(), source: { upstreamUrl: 'x', license: 'MIT' } }), undefined);
});

test('非对象输入被拒', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(toAgencyRole(bad), undefined);
  }
});

test('分部标签齐全', () => {
  assert.deepEqual(Object.keys(AGENCY_DIVISION_LABEL).sort(), ['design', 'engineering', 'product', 'testing']);
  assert.equal(AGENCY_DIVISION_LABEL.engineering, '工程');
});
