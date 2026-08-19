import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemoryKnowledgeWorkspaceStore,
  InMemoryWorkspaceKnowledgeStoreFactory,
  KnowledgeWorkspaceService,
  SqliteKnowledgeWorkspaceStore,
  SqliteWorkspaceKnowledgeStoreFactory,
} from '../src/index.js';

function service(): KnowledgeWorkspaceService {
  return new KnowledgeWorkspaceService(
    new InMemoryKnowledgeWorkspaceStore(),
    new InMemoryWorkspaceKnowledgeStoreFactory(),
  );
}

function document(id: string, text: string) {
  return {
    id,
    title: `${id} title`,
    sourceUri: `file:///knowledge/${id}.md`,
    text,
    updatedAt: 100,
  };
}

test('知识工作区使用独立索引、为每次检索生成可审查计划并可反查 citation', () => {
  const runtime = service();
  runtime.create({ id: 'workspace-alpha', title: 'Alpha', at: 1 });
  runtime.create({ id: 'workspace-beta', title: 'Beta', at: 1 });
  runtime.ingest({
    workspaceId: 'workspace-alpha', persistence: 'durable',
    document: document('doc-alpha', 'alpha-only durable architecture notes and local retrieval.'),
  });
  runtime.ingest({
    workspaceId: 'workspace-beta', persistence: 'durable',
    document: document('doc-beta', 'beta-only unrelated notes and remote archive.'),
  });

  const found = runtime.retrieve({
    workspaceId: 'workspace-alpha', persistence: 'durable', mode: 'focused',
    query: 'alpha architecture', at: 200, maxResults: 5, maxTokens: 100,
  });
  assert.equal(found.plan.workspaceId, 'workspace-alpha');
  assert.equal(found.plan.mode, 'focused');
  assert.equal(found.plan.sortingReason, 'sparse_vector_score_desc_then_document_ordinal');
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0]?.citation.workspaceId, 'workspace-alpha');
  assert.match(found.results[0]?.citation.excerpt ?? '', /alpha-only/);
  assert.deepEqual(found.plan.returnedChunkIds, [found.results[0]?.citation.chunkId]);

  const preview = runtime.previewCitation({
    workspaceId: 'workspace-alpha', persistence: 'durable', documentId: 'doc-alpha',
    chunkId: found.results[0]?.citation.chunkId ?? '',
  });
  assert.equal(preview.sourceUri, 'file:///knowledge/doc-alpha.md');
  assert.throws(() => runtime.previewCitation({
    workspaceId: 'workspace-beta', persistence: 'durable', documentId: 'doc-alpha',
    chunkId: found.results[0]?.citation.chunkId ?? '',
  }), /不属于/);
});

test('full context 必须显式指定文档并遵守 token 预算，归档工作区不可继续读取', () => {
  const runtime = service();
  runtime.create({ id: 'workspace-full', title: 'Full context', at: 1 });
  runtime.ingest({
    workspaceId: 'workspace-full', persistence: 'durable',
    document: document('doc-full', 'A short explicitly pinned reference document.'),
  });
  const full = runtime.retrieve({
    workspaceId: 'workspace-full', persistence: 'durable', mode: 'full_context',
    documentId: 'doc-full', at: 100, maxTokens: 100,
  });
  assert.deepEqual(full.plan, {
    schemaVersion: 1, workspaceId: 'workspace-full', mode: 'full_context', query: '', at: 100,
    maxResults: 1, maxTokens: 100, candidateCount: 1,
    returnedChunkIds: ['doc-full:full-context'], sortingReason: 'explicit_full_document',
  });
  assert.equal(full.results[0]?.citation.reason, 'full_context');
  assert.throws(() => runtime.retrieve({
    workspaceId: 'workspace-full', persistence: 'durable', mode: 'full_context',
    documentId: 'doc-full', at: 100, maxTokens: 1,
  }), /超过/);

  runtime.archive('workspace-full', 200);
  assert.throws(() => runtime.retrieve({
    workspaceId: 'workspace-full', persistence: 'durable', mode: 'focused',
    query: 'reference', at: 201, maxTokens: 100,
  }), /已归档/);
});

test('SQLite 工作区元数据与独立索引可在重开后恢复', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-workspace-knowledge-'));
  const metadataPath = join(directory, 'workspaces.sqlite');
  const indexesPath = join(directory, 'indexes');
  try {
    const metadata = new SqliteKnowledgeWorkspaceStore(metadataPath);
    const indexes = new SqliteWorkspaceKnowledgeStoreFactory(indexesPath);
    const first = new KnowledgeWorkspaceService(metadata, indexes);
    first.create({ id: 'workspace-sqlite', title: 'SQLite workspace', at: 1 });
    first.ingest({
      workspaceId: 'workspace-sqlite', persistence: 'durable',
      document: document('doc-sqlite', 'sqlite workspace isolated source citation'),
    });
    indexes.close();
    metadata.close();

    const reopenedMetadata = new SqliteKnowledgeWorkspaceStore(metadataPath);
    const reopenedIndexes = new SqliteWorkspaceKnowledgeStoreFactory(indexesPath);
    const reopened = new KnowledgeWorkspaceService(reopenedMetadata, reopenedIndexes);
    const found = reopened.retrieve({
      workspaceId: 'workspace-sqlite', persistence: 'durable', mode: 'focused',
      query: 'isolated citation', at: 100, maxTokens: 100,
    });
    assert.equal(reopened.list()[0]?.title, 'SQLite workspace');
    assert.equal(found.results[0]?.citation.documentId, 'doc-sqlite');
    reopenedIndexes.close();
    reopenedMetadata.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('incognito 不能写入、检索或预览持久知识工作区', () => {
  const runtime = service();
  runtime.create({ id: 'workspace-private', title: 'Private boundary', at: 1 });
  const request = {
    workspaceId: 'workspace-private', persistence: 'incognito' as const,
    document: document('doc-private', 'This must never enter persistent knowledge.'),
  };
  assert.throws(() => runtime.ingest(request), /incognito/);
  assert.throws(() => runtime.retrieve({
    workspaceId: 'workspace-private', persistence: 'incognito', mode: 'focused',
    query: 'knowledge', at: 2, maxTokens: 100,
  }), /incognito/);
  assert.throws(() => runtime.previewCitation({
    workspaceId: 'workspace-private', persistence: 'incognito', documentId: 'doc-private', chunkId: 'doc-private:chunk:0',
  }), /incognito/);
});
