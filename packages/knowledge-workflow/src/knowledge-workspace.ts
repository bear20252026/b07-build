import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryKnowledgeStore } from './in-memory-knowledge-store.js';
import { LocalKnowledgeWorkflow } from './local-knowledge-workflow.js';
import { SqliteVectorKnowledgeStore } from './sqlite-vector-knowledge-store.js';
import type {
  KnowledgeChunk,
  KnowledgeCitation,
  KnowledgeDocument,
  KnowledgeStore,
} from './types.js';

export type KnowledgeWorkspaceStatus = 'active' | 'archived';
export type KnowledgeRetrievalMode = 'focused' | 'full_context';
export type SessionPersistenceMode = 'durable' | 'ephemeral' | 'incognito';

export interface KnowledgeWorkspace {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  status: KnowledgeWorkspaceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateKnowledgeWorkspace {
  id: string;
  title: string;
  description?: string;
  at: number;
}

export interface KnowledgeWorkspaceStore {
  load(workspaceId: string): KnowledgeWorkspace | undefined;
  save(workspace: KnowledgeWorkspace): void;
  list(): readonly KnowledgeWorkspace[];
}

/** 为每个工作区返回物理上独立的索引；禁止以 post-filter 模拟范围隔离。 */
export interface WorkspaceKnowledgeStoreFactory {
  open(workspaceId: string): KnowledgeStore;
  close?(): void;
}

export interface WorkspaceKnowledgeIngestRequest {
  workspaceId: string;
  persistence: SessionPersistenceMode;
  document: KnowledgeDocument;
  maxChunkCharacters?: number;
}

export interface WorkspaceKnowledgeCitation extends KnowledgeCitation {
  workspaceId: string;
  reason: 'focused_retrieval' | 'full_context';
}

export interface WorkspaceKnowledgeResult {
  score: number;
  citation: WorkspaceKnowledgeCitation;
  estimatedTokens: number;
  mode: KnowledgeRetrievalMode;
}

export interface RetrievalPlan {
  schemaVersion: 1;
  workspaceId: string;
  mode: KnowledgeRetrievalMode;
  query: string;
  at: number;
  maxResults: number;
  maxTokens: number;
  candidateCount: number;
  returnedChunkIds: readonly string[];
  sortingReason: 'sparse_vector_score_desc_then_document_ordinal' | 'explicit_full_document';
}

export interface WorkspaceRetrievalResult {
  plan: RetrievalPlan;
  results: readonly WorkspaceKnowledgeResult[];
}

export interface FocusedRetrievalRequest {
  workspaceId: string;
  persistence: SessionPersistenceMode;
  mode: 'focused';
  query: string;
  at: number;
  maxResults?: number;
  maxTokens: number;
}

export interface FullContextRetrievalRequest {
  workspaceId: string;
  persistence: SessionPersistenceMode;
  mode: 'full_context';
  documentId: string;
  at: number;
  maxTokens: number;
}

export type WorkspaceRetrievalRequest = FocusedRetrievalRequest | FullContextRetrievalRequest;

export interface CitationPreviewRequest {
  workspaceId: string;
  persistence: SessionPersistenceMode;
  documentId: string;
  chunkId: string;
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} 必须是 1-128 位安全标识符`);
  }
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正安全整数`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function copyWorkspace(workspace: KnowledgeWorkspace): KnowledgeWorkspace {
  return { ...workspace };
}

function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function citation(workspaceId: string, chunk: KnowledgeChunk, reason: WorkspaceKnowledgeCitation['reason']): WorkspaceKnowledgeCitation {
  return {
    workspaceId,
    documentId: chunk.documentId,
    chunkId: chunk.id,
    sourceUri: chunk.sourceUri,
    title: chunk.title,
    excerpt: chunk.text.slice(0, 240),
    reason,
  };
}

function workspaceFullContextCitation(workspaceId: string, document: KnowledgeDocument): WorkspaceKnowledgeCitation {
  return {
    workspaceId,
    documentId: document.id,
    chunkId: `${document.id}:full-context`,
    sourceUri: document.sourceUri,
    title: document.title,
    excerpt: document.text.slice(0, 240),
    reason: 'full_context',
  };
}

export class InMemoryKnowledgeWorkspaceStore implements KnowledgeWorkspaceStore {
  private readonly workspaces = new Map<string, KnowledgeWorkspace>();

  load(workspaceId: string): KnowledgeWorkspace | undefined {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? copyWorkspace(workspace) : undefined;
  }

  save(workspace: KnowledgeWorkspace): void {
    this.workspaces.set(workspace.id, copyWorkspace(workspace));
  }

  list(): readonly KnowledgeWorkspace[] {
    return [...this.workspaces.values()]
      .map(copyWorkspace)
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  }
}

export class SqliteKnowledgeWorkspaceStore implements KnowledgeWorkspaceStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_workspaces (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  load(workspaceId: string): KnowledgeWorkspace | undefined {
    const row = this.db.prepare(`
      SELECT id, title, description, status, created_at, updated_at
      FROM knowledge_workspaces WHERE id = ?
    `).get(workspaceId) as {
      id: string; title: string; description: string | null; status: KnowledgeWorkspaceStatus; created_at: number; updated_at: number;
    } | undefined;
    return row ? {
      schemaVersion: 1, id: row.id, title: row.title, description: row.description ?? undefined,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    } : undefined;
  }

  save(workspace: KnowledgeWorkspace): void {
    this.db.prepare(`
      INSERT INTO knowledge_workspaces (id, title, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      workspace.id, workspace.title, workspace.description ?? null, workspace.status,
      workspace.createdAt, workspace.updatedAt,
    );
  }

  list(): readonly KnowledgeWorkspace[] {
    const rows = this.db.prepare(`
      SELECT id, title, description, status, created_at, updated_at
      FROM knowledge_workspaces ORDER BY title ASC, id ASC
    `).all() as unknown as readonly {
      id: string; title: string; description: string | null; status: KnowledgeWorkspaceStatus; created_at: number; updated_at: number;
    }[];
    return rows.map((row) => ({
      schemaVersion: 1, id: row.id, title: row.title, description: row.description ?? undefined,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export class InMemoryWorkspaceKnowledgeStoreFactory implements WorkspaceKnowledgeStoreFactory {
  private readonly stores = new Map<string, InMemoryKnowledgeStore>();

  open(workspaceId: string): KnowledgeStore {
    let store = this.stores.get(workspaceId);
    if (!store) {
      store = new InMemoryKnowledgeStore();
      this.stores.set(workspaceId, store);
    }
    return store;
  }
}

/** 每个 workspace 一个 SQLite 文件：范围隔离不依赖调用方的 WHERE 条件。 */
export class SqliteWorkspaceKnowledgeStoreFactory implements WorkspaceKnowledgeStoreFactory {
  private readonly stores = new Map<string, SqliteVectorKnowledgeStore>();

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  open(workspaceId: string): KnowledgeStore {
    assertIdentifier(workspaceId, 'workspaceId');
    let store = this.stores.get(workspaceId);
    if (!store) {
      const filePath = join(this.directory, `${workspaceId}.sqlite`);
      mkdirSync(dirname(filePath), { recursive: true });
      store = new SqliteVectorKnowledgeStore(filePath);
      this.stores.set(workspaceId, store);
    }
    return store;
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}

/**
 * 将工作区范围、检索计划与 citation 验证封装在同一边界。
 * 本类不执行文件解析、不联网、不调用模型；文件文本只能由已经通过受控工具的调用方提供。
 */
export class KnowledgeWorkspaceService {
  private readonly indexes = new Map<string, { store: KnowledgeStore; workflow: LocalKnowledgeWorkflow }>();

  constructor(
    private readonly workspaces: KnowledgeWorkspaceStore,
    private readonly storeFactory: WorkspaceKnowledgeStoreFactory,
  ) {}

  create(request: CreateKnowledgeWorkspace): KnowledgeWorkspace {
    assertIdentifier(request.id, 'workspace id');
    assertEpoch(request.at, 'at');
    if (!request.title.trim()) throw new Error('workspace title 不能为空');
    if (request.title.trim().length > 160) throw new Error('workspace title 不得超过 160 个字符');
    if (request.description !== undefined && request.description.length > 2_000) {
      throw new Error('workspace description 不得超过 2000 个字符');
    }
    if (this.workspaces.load(request.id)) throw new Error(`知识工作区 ${request.id} 已存在`);
    const workspace: KnowledgeWorkspace = {
      schemaVersion: 1,
      id: request.id,
      title: request.title.trim(),
      description: request.description?.trim() || undefined,
      status: 'active',
      createdAt: request.at,
      updatedAt: request.at,
    };
    this.workspaces.save(workspace);
    return copyWorkspace(workspace);
  }

  archive(workspaceId: string, at: number): KnowledgeWorkspace {
    const current = this.requireWorkspace(workspaceId);
    assertEpoch(at, 'at');
    const next: KnowledgeWorkspace = { ...current, status: 'archived', updatedAt: at };
    this.workspaces.save(next);
    return copyWorkspace(next);
  }

  list(): readonly KnowledgeWorkspace[] {
    return this.workspaces.list().map(copyWorkspace);
  }

  ingest(request: WorkspaceKnowledgeIngestRequest): readonly KnowledgeChunk[] {
    this.assertPersistentKnowledgeAccess(request.workspaceId, request.persistence);
    const document = request.document;
    assertIdentifier(document.id, 'document id');
    const chunks = this.indexFor(request.workspaceId).workflow.ingest({
      document: { ...document }, maxChunkCharacters: request.maxChunkCharacters,
    });
    return chunks.map((chunk) => ({ ...chunk }));
  }

  retrieve(request: WorkspaceRetrievalRequest): WorkspaceRetrievalResult {
    this.assertPersistentKnowledgeAccess(request.workspaceId, request.persistence);
    assertEpoch(request.at, 'at');
    assertNonNegativeInteger(request.maxTokens, 'maxTokens');
    const { store, workflow } = this.indexFor(request.workspaceId);
    if (request.mode === 'full_context') {
      assertIdentifier(request.documentId, 'documentId');
      const document = store.document(request.documentId);
      if (!document) throw new Error(`文档 ${request.documentId} 不属于知识工作区 ${request.workspaceId}`);
      const tokens = estimatedTokens(document.text);
      if (tokens > request.maxTokens) throw new Error('全文上下文超过检索计划 token 预算；请使用 focused 检索');
      const result: WorkspaceKnowledgeResult = {
        score: 1,
        citation: workspaceFullContextCitation(request.workspaceId, document),
        estimatedTokens: tokens,
        mode: 'full_context',
      };
      return {
        plan: {
          schemaVersion: 1, workspaceId: request.workspaceId, mode: request.mode, query: '', at: request.at,
          maxResults: 1, maxTokens: request.maxTokens, candidateCount: 1,
          returnedChunkIds: [result.citation.chunkId], sortingReason: 'explicit_full_document',
        },
        results: [result],
      };
    }

    if (!request.query.trim()) throw new Error('focused 检索 query 不能为空');
    const maxResults = request.maxResults ?? 5;
    assertPositiveInteger(maxResults, 'maxResults');
    const allMatches = workflow.search(request.query, maxResults);
    const results: WorkspaceKnowledgeResult[] = [];
    let tokens = 0;
    for (const match of allMatches) {
      const itemTokens = estimatedTokens(match.chunk.text);
      if (tokens + itemTokens > request.maxTokens) continue;
      tokens += itemTokens;
      results.push({
        score: match.score,
        citation: citation(request.workspaceId, match.chunk, 'focused_retrieval'),
        estimatedTokens: itemTokens,
        mode: 'focused',
      });
    }
    return {
      plan: {
        schemaVersion: 1, workspaceId: request.workspaceId, mode: request.mode, query: request.query.trim(), at: request.at,
        maxResults, maxTokens: request.maxTokens, candidateCount: allMatches.length,
        returnedChunkIds: results.map((result) => result.citation.chunkId),
        sortingReason: 'sparse_vector_score_desc_then_document_ordinal',
      },
      results,
    };
  }

  previewCitation(request: CitationPreviewRequest): WorkspaceKnowledgeCitation {
    this.assertPersistentKnowledgeAccess(request.workspaceId, request.persistence);
    assertIdentifier(request.documentId, 'documentId');
    assertIdentifier(request.chunkId, 'chunkId');
    const { store } = this.indexFor(request.workspaceId);
    if (!store.document(request.documentId)) {
      throw new Error(`文档 ${request.documentId} 不属于知识工作区 ${request.workspaceId}`);
    }
    const chunk = store.chunks().find((candidate) => candidate.id === request.chunkId && candidate.documentId === request.documentId);
    if (!chunk) throw new Error('citation 不属于指定工作区文档');
    return citation(request.workspaceId, chunk, 'focused_retrieval');
  }

  private indexFor(workspaceId: string): { store: KnowledgeStore; workflow: LocalKnowledgeWorkflow } {
    let index = this.indexes.get(workspaceId);
    if (!index) {
      const store = this.storeFactory.open(workspaceId);
      index = { store, workflow: new LocalKnowledgeWorkflow(store) };
      this.indexes.set(workspaceId, index);
    }
    return index;
  }

  private assertPersistentKnowledgeAccess(workspaceId: string, persistence: SessionPersistenceMode): void {
    assertIdentifier(workspaceId, 'workspaceId');
    if (persistence === 'incognito') throw new Error('incognito 会话不得摄取、索引或读取持久知识工作区');
    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.status !== 'active') throw new Error(`知识工作区 ${workspaceId} 已归档，不能继续使用`);
  }

  private requireWorkspace(workspaceId: string): KnowledgeWorkspace {
    assertIdentifier(workspaceId, 'workspaceId');
    const workspace = this.workspaces.load(workspaceId);
    if (!workspace) throw new Error(`知识工作区 ${workspaceId} 不存在`);
    return workspace;
  }
}
