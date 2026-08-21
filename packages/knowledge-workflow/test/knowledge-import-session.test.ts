import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemoryKnowledgeImportSessionStore,
  KnowledgeImportSessionRegistry,
  SqliteKnowledgeImportSessionStore,
} from '../src/index.js';

test('知识导入只接受显式文本，记录可审查摘要并通过完成状态释放 staged 语义', () => {
  const registry = new KnowledgeImportSessionRegistry(new InMemoryKnowledgeImportSessionStore());
  const staged = registry.start({
    importId: 'import-1', workspaceId: 'workspace-1', documentId: 'document-1', title: '学习笔记',
    sourceUri: 'manual://study-note', text: '第一段\n\n第二段', storageBudgetBytes: 10_000, at: 1,
  });
  assert.equal(staged.status, 'staged');
  assert.equal(staged.declaredBytes, Buffer.byteLength('第一段\n\n第二段', 'utf8'));
  assert.match(staged.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(staged).includes('第一段'), false);

  const indexed = registry.complete(staged.importId, 2, 2);
  assert.equal(indexed.status, 'indexed');
  assert.equal(indexed.chunkCount, 2);
  assert.equal(registry.list('workspace-1')[0]?.revision, 2);
  assert.throws(() => registry.cancel(staged.importId, 3), /不能从 indexed/);
});

test('知识导入预算只计算 staged/indexed，取消未完成导入后允许新的显式来源进入', () => {
  const registry = new KnowledgeImportSessionRegistry(new InMemoryKnowledgeImportSessionStore());
  registry.start({ importId: 'import-a', workspaceId: 'workspace-1', documentId: 'document-a', title: 'A', sourceUri: 'manual://a', text: '12345', storageBudgetBytes: 5, at: 1 });
  assert.throws(() => registry.start({ importId: 'import-b', workspaceId: 'workspace-1', documentId: 'document-b', title: 'B', sourceUri: 'manual://b', text: '1', storageBudgetBytes: 5, at: 2 }), /存储预算不足/);
  registry.cancel('import-a', 3);
  assert.equal(registry.start({ importId: 'import-b', workspaceId: 'workspace-1', documentId: 'document-b', title: 'B', sourceUri: 'manual://b', text: '1', storageBudgetBytes: 5, at: 4 }).status, 'staged');
});

test('SQLite 知识导入账本可重开并保留追加式状态历史', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-knowledge-import-'));
  const path = join(root, 'imports.sqlite');
  try {
    const firstStore = new SqliteKnowledgeImportSessionStore(path);
    const first = new KnowledgeImportSessionRegistry(firstStore);
    first.start({ importId: 'import-1', workspaceId: 'workspace-1', documentId: 'document-1', title: 'A', sourceUri: 'manual://a', text: '内容', storageBudgetBytes: 1_000, at: 1 });
    first.fail('import-1', 'parse_failed', 2);
    firstStore.close();

    const secondStore = new SqliteKnowledgeImportSessionStore(path);
    const second = new KnowledgeImportSessionRegistry(secondStore);
    assert.equal(second.get('import-1')?.status, 'failed');
    assert.deepEqual(secondStore.history('import-1').map((item) => item.status), ['staged', 'failed']);
    secondStore.close();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
