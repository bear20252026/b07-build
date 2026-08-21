import assert from 'node:assert/strict';
import test from 'node:test';
import { AgencyRoleCatalog } from '../src/index.js';

test('agency 角色目录列出带 MIT 归因的固定角色，metadata 不泄漏正文且不自动注入或授权', () => {
  const catalog = new AgencyRoleCatalog();
  const roles = catalog.list();
  assert.equal(roles.length, 8);
  assert.equal(roles.some((item) => item.id === 'agency.software-architect'), true);
  for (const role of roles) {
    assert.equal(Object.hasOwn(role, 'content'), false);
    assert.equal(role.source.repository, 'msitarzewski/agency-agents');
    assert.equal(role.source.license, 'MIT');
    assert.equal(role.source.copyright, 'Copyright (c) 2025 AgentLand Contributors');
    assert.match(role.source.contentDigest, /^[a-f0-9]{64}$/);
    assert.equal(role.canAutoInject, false);
    assert.equal(role.canAuthorize, false);
    assert.equal(role.canGrantCapabilities, false);
  }
});

test('agency 角色详情保留上游版权头，并只能转换为需要既有审查的 Skill Pack 候选', () => {
  const catalog = new AgencyRoleCatalog();
  const role = catalog.get('agency.code-reviewer');
  assert.ok(role);
  assert.match(role.content, /Copyright \(c\) 2025 AgentLand Contributors/);
  assert.match(role.content, /AI Work OS adaptation notice/);
  const candidate = catalog.toSkillPackCandidate('agency.code-reviewer', 1_000);
  assert.equal(candidate.id, 'role.agency.code-reviewer');
  assert.equal(candidate.source.type, 'git');
  assert.equal(candidate.source.digest, role.source.contentDigest);
  assert.equal(candidate.content, role.content);
  assert.equal(candidate.scope?.workspaceIds, undefined);
  assert.match(candidate.note ?? '', /不授予权限/);
});

test('agency 角色目录不会为不存在角色生成候选', () => {
  const catalog = new AgencyRoleCatalog();
  assert.equal(catalog.get('agency.nope'), undefined);
  assert.throws(() => catalog.toSkillPackCandidate('agency.nope', 1), /不存在/);
});
