import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type KnowledgeImportStatus = 'staged' | 'indexed' | 'failed' | 'cancelled';

export interface KnowledgeImportSessionV1 {
  schemaVersion: 1;
  importId: string;
  revision: number;
  status: KnowledgeImportStatus;
  workspaceId: string;
  documentId: string;
  title: string;
  sourceUri: string;
  contentDigest: string;
  declaredBytes: number;
  storageBudgetBytes: number;
  chunkCount?: number;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StartKnowledgeImportRequest {
  importId: string;
  workspaceId: string;
  documentId: string;
  title: string;
  sourceUri: string;
  text: string;
  storageBudgetBytes: number;
  at: number;
}

export interface KnowledgeImportSessionStore {
  load(importId: string): KnowledgeImportSessionV1 | undefined;
  history(importId: string): readonly KnowledgeImportSessionV1[];
  list(workspaceId: string): readonly KnowledgeImportSessionV1[];
  append(session: KnowledgeImportSessionV1): void;
}

function copy(session: KnowledgeImportSessionV1): KnowledgeImportSessionV1 {
  return { ...session };
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${name} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('at 必须是非负安全整数毫秒时间戳');
}

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正安全整数`);
}

function bytesFor(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function digestFor(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validateTransition(from: KnowledgeImportStatus, to: KnowledgeImportStatus): boolean {
  return (from === 'staged' && (to === 'indexed' || to === 'failed' || to === 'cancelled'));
}

/** 用户显式选择的知识文本导入账本；不持久化正文、绝对路径、凭据或外部端点。 */
export class KnowledgeImportSessionRegistry {
  constructor(private readonly store: KnowledgeImportSessionStore) {}

  start(request: StartKnowledgeImportRequest): KnowledgeImportSessionV1 {
    assertIdentifier(request.importId, 'importId');
    assertIdentifier(request.workspaceId, 'workspaceId');
    assertIdentifier(request.documentId, 'documentId');
    assertEpoch(request.at);
    assertPositive(request.storageBudgetBytes, 'storageBudgetBytes');
    if (!request.title.trim() || !request.sourceUri.trim() || !request.text.trim()) throw new Error('导入必须具有非空 title、sourceUri 与文本');
    if (request.text.length > 1_500_000) throw new Error('单次导入文本不得超过 1500000 字符');
    if (this.store.load(request.importId)) throw new Error(`知识导入 ${request.importId} 已存在`);
    const declaredBytes = bytesFor(request.text);
    const consumedBytes = this.store.list(request.workspaceId)
      .filter((session) => session.status === 'staged' || session.status === 'indexed')
      .reduce((total, session) => total + session.declaredBytes, 0);
    if (consumedBytes + declaredBytes > request.storageBudgetBytes) throw new Error('知识工作区存储预算不足；请取消未完成导入或提高明确预算');
    const session: KnowledgeImportSessionV1 = {
      schemaVersion: 1,
      importId: request.importId,
      revision: 1,
      status: 'staged',
      workspaceId: request.workspaceId,
      documentId: request.documentId,
      title: request.title.trim(),
      sourceUri: request.sourceUri.trim(),
      contentDigest: digestFor(request.text),
      declaredBytes,
      storageBudgetBytes: request.storageBudgetBytes,
      createdAt: request.at,
      updatedAt: request.at,
    };
    this.store.append(session);
    return copy(session);
  }

  complete(importId: string, chunkCount: number, at: number): KnowledgeImportSessionV1 {
    assertPositive(chunkCount, 'chunkCount');
    return this.transition(importId, 'indexed', at, { chunkCount });
  }

  fail(importId: string, failureCode: string, at: number): KnowledgeImportSessionV1 {
    if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(failureCode)) throw new Error('failureCode 必须是安全标识符');
    return this.transition(importId, 'failed', at, { failureCode });
  }

  cancel(importId: string, at: number): KnowledgeImportSessionV1 {
    return this.transition(importId, 'cancelled', at, {});
  }

  get(importId: string): KnowledgeImportSessionV1 | undefined {
    assertIdentifier(importId, 'importId');
    const session = this.store.load(importId);
    return session ? copy(session) : undefined;
  }

  list(workspaceId: string): readonly KnowledgeImportSessionV1[] {
    assertIdentifier(workspaceId, 'workspaceId');
    return this.store.list(workspaceId).map(copy);
  }

  private transition(importId: string, status: KnowledgeImportStatus, at: number, patch: Pick<Partial<KnowledgeImportSessionV1>, 'chunkCount' | 'failureCode'>): KnowledgeImportSessionV1 {
    assertIdentifier(importId, 'importId');
    assertEpoch(at);
    const current = this.store.load(importId);
    if (!current) throw new Error(`知识导入 ${importId} 不存在`);
    if (!validateTransition(current.status, status)) throw new Error(`知识导入 ${importId} 不能从 ${current.status} 变更为 ${status}`);
    const next: KnowledgeImportSessionV1 = { ...current, ...patch, revision: current.revision + 1, status, updatedAt: at };
    this.store.append(next);
    return copy(next);
  }
}

export class InMemoryKnowledgeImportSessionStore implements KnowledgeImportSessionStore {
  private readonly sessions = new Map<string, KnowledgeImportSessionV1[]>();

  load(importId: string): KnowledgeImportSessionV1 | undefined {
    const current = this.sessions.get(importId)?.at(-1);
    return current ? copy(current) : undefined;
  }

  history(importId: string): readonly KnowledgeImportSessionV1[] {
    return (this.sessions.get(importId) ?? []).map(copy);
  }

  list(workspaceId: string): readonly KnowledgeImportSessionV1[] {
    return [...this.sessions.values()].map((history) => history.at(-1)).filter((item): item is KnowledgeImportSessionV1 => Boolean(item))
      .filter((item) => item.workspaceId === workspaceId).map(copy).sort((left, right) => left.updatedAt - right.updatedAt || left.importId.localeCompare(right.importId));
  }

  append(session: KnowledgeImportSessionV1): void {
    const history = this.sessions.get(session.importId) ?? [];
    const current = history.at(-1);
    if ((!current && session.revision !== 1) || (current && session.revision !== current.revision + 1)) throw new Error('知识导入 revision 必须严格递增');
    this.sessions.set(session.importId, [...history, copy(session)]);
  }
}

export class SqliteKnowledgeImportSessionStore implements KnowledgeImportSessionStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_import_revisions (
      import_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
      workspace_id TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT NOT NULL, source_uri TEXT NOT NULL,
      content_digest TEXT NOT NULL, declared_bytes INTEGER NOT NULL, storage_budget_bytes INTEGER NOT NULL,
      chunk_count INTEGER, failure_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (import_id, revision)
    ); CREATE INDEX IF NOT EXISTS idx_knowledge_import_latest ON knowledge_import_revisions (workspace_id, import_id, revision DESC);`);
  }

  load(importId: string): KnowledgeImportSessionV1 | undefined {
    const row = this.db.prepare('SELECT * FROM knowledge_import_revisions WHERE import_id = ? ORDER BY revision DESC LIMIT 1').get(importId) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  history(importId: string): readonly KnowledgeImportSessionV1[] {
    return (this.db.prepare('SELECT * FROM knowledge_import_revisions WHERE import_id = ? ORDER BY revision ASC').all(importId) as Record<string, unknown>[]).map((row) => this.fromRow(row));
  }

  list(workspaceId: string): readonly KnowledgeImportSessionV1[] {
    const rows = this.db.prepare(`SELECT r.* FROM knowledge_import_revisions r INNER JOIN (
      SELECT import_id, MAX(revision) revision FROM knowledge_import_revisions WHERE workspace_id = ? GROUP BY import_id
    ) latest ON latest.import_id = r.import_id AND latest.revision = r.revision ORDER BY r.updated_at ASC, r.import_id ASC`).all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }

  append(session: KnowledgeImportSessionV1): void {
    this.db.prepare(`INSERT INTO knowledge_import_revisions (
      import_id, revision, status, workspace_id, document_id, title, source_uri, content_digest, declared_bytes, storage_budget_bytes,
      chunk_count, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      session.importId, session.revision, session.status, session.workspaceId, session.documentId, session.title, session.sourceUri,
      session.contentDigest, session.declaredBytes, session.storageBudgetBytes, session.chunkCount ?? null, session.failureCode ?? null,
      session.createdAt, session.updatedAt,
    );
  }

  close(): void { this.db.close(); }

  private fromRow(row: Record<string, unknown>): KnowledgeImportSessionV1 {
    return {
      schemaVersion: 1, importId: String(row.import_id), revision: Number(row.revision), status: String(row.status) as KnowledgeImportStatus,
      workspaceId: String(row.workspace_id), documentId: String(row.document_id), title: String(row.title), sourceUri: String(row.source_uri),
      contentDigest: String(row.content_digest), declaredBytes: Number(row.declared_bytes), storageBudgetBytes: Number(row.storage_budget_bytes),
      chunkCount: row.chunk_count === null ? undefined : Number(row.chunk_count), failureCode: row.failure_code === null ? undefined : String(row.failure_code),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }
}
