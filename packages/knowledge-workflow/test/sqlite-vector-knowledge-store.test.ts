import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalKnowledgeWorkflow, SqliteVectorKnowledgeStore } from '../src/index.js';

function withStore(run: (workflow: LocalKnowledgeWorkflow, reopen: () => LocalKnowledgeWorkflow) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'awo-vector-'));
  const path = join(dir, 'knowledge.sqlite');
  let store: SqliteVectorKnowledgeStore | undefined = new SqliteVectorKnowledgeStore(path);
  try {
    run(new LocalKnowledgeWorkflow(store), () => {
      store?.close();
      store = new SqliteVectorKnowledgeStore(path);
      return new LocalKnowledgeWorkflow(store);
    });
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SQLite 向量存储持久化来源引用，并在重开数据库后保持本地相似度检索', () => {
  withStore((workflow, reopen) => {
    workflow.ingest({
      document: {
        id: 'runtime',
        title: '本地任务恢复',
        sourceUri: 'file:///docs/runtime.md',
        text: 'SQLite 快照以 append-only 方式保留任务历史。\n\n审批后只重跑未完成节点。',
        updatedAt: 1,
      },
      maxChunkCharacters: 128,
    });
    const first = workflow.search('SQLite 快照');
    assert.equal(first.length, 1);
    assert.equal(first[0]?.citation.sourceUri, 'file:///docs/runtime.md');
    assert.equal(first[0]?.citation.chunkId, 'runtime:chunk:0');

    const reopened = reopen();
    assert.equal(reopened.search('审批 未完成')[0]?.chunk.documentId, 'runtime');
  });
});

test('替换同一文档会在普通表和向量表中同时删除过期片段', () => {
  withStore((workflow) => {
    workflow.ingest({
      document: { id: 'guide', title: '旧指南', sourceUri: 'file:///old.md', text: '旧版向量词条不可保留。', updatedAt: 1 },
      maxChunkCharacters: 128,
    });
    workflow.ingest({
      document: { id: 'guide', title: '新指南', sourceUri: 'file:///new.md', text: 'SQLite 向量检索的引用预览必须显示来源。', updatedAt: 2 },
      maxChunkCharacters: 128,
    });
    assert.equal(workflow.search('旧版 词条').length, 0);
    const current = workflow.search('引用预览 来源');
    assert.equal(current.length, 1);
    assert.equal(current[0]?.citation.sourceUri, 'file:///new.md');
  });
});

test('向量结果使用相似度与文档标识稳定排序，且特殊字符不会进入查询语法', () => {
  withStore((workflow) => {
    workflow.ingest({
      document: { id: 'beta', title: 'B', sourceUri: 'file:///b.md', text: '本地检索返回来源。', updatedAt: 1 },
      maxChunkCharacters: 128,
    });
    workflow.ingest({
      document: { id: 'alpha', title: 'A', sourceUri: 'file:///a.md', text: '本地检索返回来源。', updatedAt: 1 },
      maxChunkCharacters: 128,
    });
    assert.deepEqual(workflow.search('本地检索').map((result) => result.chunk.documentId), ['alpha', 'beta']);
    assert.deepEqual(workflow.search('" OR *'), []);
  });
});
