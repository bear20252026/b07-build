import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryKnowledgeWorkspaceStore,
  InMemorySkillPackStore,
  InMemoryWorkspaceKnowledgeStoreFactory,
  KnowledgeWorkspaceService,
  SkillPackRegistry,
  SqliteSkillPackStore,
} from '../src/index.js';

const digest = 'a'.repeat(64);

function candidate(registry: SkillPackRegistry, id = 'skill.local-writing'): void {
  registry.registerCandidate({
    id,
    version: '1.0.0',
    displayName: '本地写作约定',
    source: { type: 'local-path', locator: '/opt/awo/skills/local-writing/SKILL.md', digest },
    content: '只使用本地来源。输出结论时列出引用。不得把本技能当作工具授权。',
    estimatedTokens: 24,
    maxInjectionTokens: 20,
    scope: { workspaceIds: ['workspace-alpha'], agentIds: ['agent-writer'] },
    note: '纯文本候选；无入口、无密钥、无 capability。',
    at: 100,
  });
}

function publish(registry: SkillPackRegistry, id = 'skill.local-writing'): void {
  registry.review(id, 'local-admin', 110, '来源、范围和 token 预算已审查。');
  registry.publish(id, digest, 'local-admin', 120, '摘要已复核。');
}

test('Skill Pack 默认仅 candidate，完整审查和 digest 核验后才允许显式上下文注入', () => {
  const registry = new SkillPackRegistry(new InMemorySkillPackStore());
  candidate(registry);
  assert.equal(registry.get('skill.local-writing')?.status, 'candidate');
  assert.deepEqual(registry.eligible(), []);
  assert.throws(() => registry.publish('skill.local-writing', digest, 'local-admin', 110), /不能从 candidate/);
  registry.review('skill.local-writing', 'local-admin', 110);
  assert.throws(() => registry.publish('skill.local-writing', 'b'.repeat(64), 'local-admin', 120), /摘要不一致/);
  const published = registry.publish('skill.local-writing', digest, 'local-admin', 120);
  assert.equal(published.status, 'published');
  assert.equal(published.injectionPolicy.canAuthorize, false);
  assert.equal(published.injectionPolicy.canGrantCapabilities, false);
});

test('Skill Pack 注入必须显式引用、遵守范围和 token 预算，并永远不产生权限', () => {
  const registry = new SkillPackRegistry(new InMemorySkillPackStore());
  candidate(registry);
  publish(registry);

  const plan = registry.prepareInjections({
    workspaceId: 'workspace-alpha', agentId: 'agent-writer', persistence: 'durable',
    packIds: ['skill.local-writing', 'skill.local-writing', 'missing-pack'], maxTokens: 20, at: 130,
  });
  assert.equal(plan.implicitSelection, false);
  assert.deepEqual(plan.requestedPackIds, ['skill.local-writing', 'missing-pack']);
  assert.equal(plan.injected.length, 1);
  assert.equal(plan.injected[0]?.estimatedTokens, 20);
  assert.equal(plan.injected[0]?.canAuthorize, false);
  assert.equal(plan.injected[0]?.canGrantCapabilities, false);
  assert.deepEqual(plan.omitted, [{ packId: 'missing-pack', reason: 'missing' }]);

  const outOfScope = registry.prepareInjections({
    workspaceId: 'workspace-beta', agentId: 'agent-writer', persistence: 'durable',
    packIds: ['skill.local-writing'], maxTokens: 40, at: 131,
  });
  assert.deepEqual(outOfScope.omitted, [{ packId: 'skill.local-writing', reason: 'out_of_scope' }]);
  assert.throws(() => registry.prepareInjections({
    workspaceId: 'workspace-alpha', agentId: 'agent-writer', persistence: 'incognito',
    packIds: ['skill.local-writing'], maxTokens: 40, at: 132,
  }), /incognito/);
});

test('停用与撤销会阻断旧 injection，撤销的 Skill Pack 永远不能复活', () => {
  const registry = new SkillPackRegistry(new InMemorySkillPackStore());
  candidate(registry);
  publish(registry);
  const injection = registry.prepareInjections({
    workspaceId: 'workspace-alpha', agentId: 'agent-writer', persistence: 'durable',
    packIds: ['skill.local-writing'], maxTokens: 40, at: 130,
  }).injected[0];
  assert.ok(injection);
  registry.assertInjectionCurrent(injection!);
  registry.disable('skill.local-writing', 'local-admin', 140, '需要重新审查。');
  assert.throws(() => registry.assertInjectionCurrent(injection!), /已停用、撤销或更新/);
  registry.publish('skill.local-writing', digest, 'local-admin', 150, '重新审查后发布。');
  registry.revoke('skill.local-writing', 'local-admin', 160, '来源撤销。');
  assert.throws(() => registry.publish('skill.local-writing', digest, 'local-admin', 170), /不能从 revoked/);
  assert.deepEqual(registry.history('skill.local-writing').map((item) => item.status), [
    'candidate', 'reviewed', 'published', 'disabled', 'published', 'revoked',
  ]);
});

test('SQLite Skill Pack 账本追加 revision、返回防御性副本，并在重开后保持可审查历史', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-skill-pack-'));
  const filePath = join(directory, 'skill-packs.sqlite');
  try {
    const store = new SqliteSkillPackStore(filePath);
    const registry = new SkillPackRegistry(store);
    candidate(registry, 'skill.sqlite');
    registry.review('skill.sqlite', 'local-admin', 110);
    registry.publish('skill.sqlite', digest, 'local-admin', 120);
    const copy = registry.get('skill.sqlite');
    assert.ok(copy);
    (copy!.scope.workspaceIds as string[]).push('workspace-tamper');
    assert.deepEqual(registry.get('skill.sqlite')?.scope.workspaceIds, ['workspace-alpha']);
    store.close();

    const reopened = new SqliteSkillPackStore(filePath);
    assert.deepEqual(reopened.history('skill.sqlite').map((item) => item.status), ['candidate', 'reviewed', 'published']);
    assert.equal(reopened.load('skill.sqlite')?.source.digest, digest);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('知识工作区为 Skill Pack 注入生成独立的 provenance citation，而不把纯文本变为知识文档或权限', () => {
  const registry = new SkillPackRegistry(new InMemorySkillPackStore());
  candidate(registry);
  publish(registry);
  const injection = registry.prepareInjections({
    workspaceId: 'workspace-alpha', agentId: 'agent-writer', persistence: 'durable',
    packIds: ['skill.local-writing'], maxTokens: 40, at: 130,
  }).injected[0];
  assert.ok(injection);
  const knowledge = new KnowledgeWorkspaceService(
    new InMemoryKnowledgeWorkspaceStore(),
    new InMemoryWorkspaceKnowledgeStoreFactory(),
  );
  knowledge.create({ id: 'workspace-alpha', title: 'Alpha', at: 1 });
  const citation = knowledge.citeSkillPackContext({
    workspaceId: 'workspace-alpha', persistence: 'durable', injection: injection!,
  });
  assert.deepEqual(citation, {
    kind: 'skill-pack', workspaceId: 'workspace-alpha', packId: 'skill.local-writing', packRevision: 3,
    version: '1.0.0', displayName: '本地写作约定', sourceType: 'local-path',
    sourceLocator: '/opt/awo/skills/local-writing/SKILL.md', sourceDigest: digest, estimatedTokens: 20,
    canAuthorize: false, canGrantCapabilities: false,
    revocation: { packId: 'skill.local-writing', verifyAtUse: true },
  });
  assert.throws(() => knowledge.citeSkillPackContext({
    workspaceId: 'workspace-alpha', persistence: 'incognito', injection: injection!,
  }), /incognito/);
});
