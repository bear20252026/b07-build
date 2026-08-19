import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryKnowledgeStore, LocalKnowledgeWorkflow } from '../src/index.js';

function workflow(): LocalKnowledgeWorkflow {
  return new LocalKnowledgeWorkflow(new InMemoryKnowledgeStore());
}

test('摄取会生成稳定分块，替换同一文档不会遗留过期片段', () => {
  const value = workflow();
  const first = value.ingest({
    document: {
      id: 'design',
      title: '本地恢复设计',
      sourceUri: 'file:///docs/recovery.md',
      text: 'SQLite 快照是 append-only 的。\n\n任务恢复只重跑未完成节点。',
      updatedAt: 1,
    },
    maxChunkCharacters: 128,
  });
  assert.deepEqual(first.map((chunk) => chunk.id), ['design:chunk:0']);
  value.ingest({
    document: {
      id: 'design',
      title: '本地恢复设计',
      sourceUri: 'file:///docs/recovery.md',
      text: '恢复操作保留来源引用。',
      updatedAt: 2,
    },
    maxChunkCharacters: 128,
  });
  assert.equal(value.search('SQLite').length, 0);
  assert.equal(value.search('来源')[0]?.chunk.id, 'design:chunk:0');
});

test('检索返回带来源的引用，并用分数和文档标识确定性排序', () => {
  const value = workflow();
  value.ingest({
    document: { id: 'beta', title: 'B', sourceUri: 'file:///b.md', text: '本地 Agent 使用 SQLite 快照。', updatedAt: 1 },
    maxChunkCharacters: 128,
  });
  value.ingest({
    document: { id: 'alpha', title: 'A', sourceUri: 'file:///a.md', text: '本地 Agent 审批和 SQLite 快照。', updatedAt: 1 },
    maxChunkCharacters: 128,
  });
  const results = value.search('本地 SQLite');
  assert.deepEqual(results.map((result) => result.chunk.documentId), ['alpha', 'beta']);
  assert.deepEqual(results[0]?.citation, {
    documentId: 'alpha',
    chunkId: 'alpha:chunk:0',
    sourceUri: 'file:///a.md',
    title: 'A',
    excerpt: '本地 Agent 审批和 SQLite 快照。',
  });
});

test('知识工作流拒绝缺少可追溯来源的文档和无效分块限制', () => {
  const value = workflow();
  assert.throws(() => value.ingest({
    document: { id: '', title: '', sourceUri: '', text: '', updatedAt: 1 },
  }), /必须具有/);
  assert.throws(() => value.ingest({
    document: { id: 'x', title: 'X', sourceUri: 'file:///x', text: '文本', updatedAt: 1 },
    maxChunkCharacters: 127,
  }), /不小于 128/);
});
