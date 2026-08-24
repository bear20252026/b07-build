import assert from 'node:assert/strict';
import test from 'node:test';
import { projectHaloSearchItems } from '../src/components/layout/halo-search-projection.js';

const source = {
  projects: [{ schemaVersion: 1 as const, projectId: 'project-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: '发布修复', description: 'Windows 云端构建与核验', createdAt: 1, updatedAt: 2, taskCount: 3 }],
  conversations: [{ schemaVersion: 1 as const, id: 'conversation-1', title: 'Provider 直连排查', selection: { providerId: 'mimo', model: 'mimo-v2.5' }, messages: [], createdAt: 1, updatedAt: 2 }],
  knowledge: [{ schemaVersion: 1 as const, id: 'knowledge-1', title: 'Apple 设计记录', sourceKind: 'manual-text' as const, declaredBytes: 22, indexedAt: 3, termIndex: ['apple'], sourcePreview: '克制白灰蓝与单内容 Inspector。' }],
};

test('Halo Search 只投影现有本地标题、知识库预览和本地导航动作', () => {
  const provider = projectHaloSearchItems(source, 'Provider');
  assert.ok(provider.some((item) => item.id === 'conversation-conversation-1'));
  assert.ok(provider.some((item) => item.id === 'surface-models'));
  assert.deepEqual(provider.find((item) => item.id === 'conversation-conversation-1')?.action, { kind: 'conversation', id: 'conversation-1' });
  const knowledge = projectHaloSearchItems(source, 'Apple');
  assert.equal(knowledge[0]?.action.kind, 'local-knowledge');
  assert.equal(projectHaloSearchItems(source, '不存在').length, 0);
});
