import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  KnowledgeChunk,
  KnowledgeChunkMatch,
  KnowledgeDocument,
  KnowledgeStore,
  SearchableKnowledgeStore,
} from './types.js';

type SparseVector = Record<string, number>;

interface DocumentRow {
  id: string;
  title: string;
  source_uri: string;
  text: string;
  updated_at: number;
}

interface ChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  text: string;
  source_uri: string;
  title: string;
}

interface VectorRow extends ChunkRow {
  vector_json: string;
}

function copyDocument(document: KnowledgeDocument): KnowledgeDocument {
  return { ...document };
}

function copyChunk(chunk: KnowledgeChunk): KnowledgeChunk {
  return { ...chunk };
}

/**
 * 纯本地词元化：英文/数字采用词项，汉字连续文本同时采用单字与相邻二元组。
 * 这不是语义嵌入模型，但会生成可持久化、可解释、可替换的稀疏向量，并不依赖 SQLite 编译选项。
 */
function lexemes(text: string): readonly string[] {
  const result: string[] = [];
  for (const run of text.toLocaleLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(run)) {
      for (const character of run) result.push(`han:${character}`);
      for (let index = 0; index < run.length - 1; index += 1) result.push(`han2:${run.slice(index, index + 2)}`);
    } else {
      result.push(`word:${run}`);
    }
  }
  return result;
}

function vectorFor(text: string): SparseVector {
  const counts: SparseVector = {};
  for (const term of lexemes(text)) counts[term] = (counts[term] ?? 0) + 1;
  const magnitude = Math.sqrt(Object.values(counts).reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) return counts;
  for (const term of Object.keys(counts)) counts[term] /= magnitude;
  return counts;
}

function cosine(left: SparseVector, right: SparseVector): number {
  const [smaller, larger] = Object.keys(left).length <= Object.keys(right).length ? [left, right] : [right, left];
  return Object.entries(smaller).reduce((total, [term, value]) => total + value * (larger[term] ?? 0), 0);
}

/**
 * SQLite 本地稀疏向量存储。它将确定性词元向量序列化到普通 SQLite 表，因此在 Node 内置 SQLite
 * 不含 FTS5 扩展时仍可运行。后续密集 embedding 或 sqlite-vec adapter 只需实现同一 SearchableKnowledgeStore 端口。
 */
export class SqliteVectorKnowledgeStore implements KnowledgeStore, SearchableKnowledgeStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        title TEXT NOT NULL,
        UNIQUE(document_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
        ON knowledge_chunks(document_id, ordinal);
      CREATE TABLE IF NOT EXISTS knowledge_chunk_vectors (
        chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        vector_json TEXT NOT NULL
      );
    `);
  }

  replaceDocument(document: KnowledgeDocument, chunks: readonly KnowledgeChunk[]): void {
    const insertDocument = this.db.prepare(`
      INSERT INTO knowledge_documents (id, title, source_uri, text, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        source_uri = excluded.source_uri,
        text = excluded.text,
        updated_at = excluded.updated_at
    `);
    const deleteVectors = this.db.prepare(`
      DELETE FROM knowledge_chunk_vectors
      WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)
    `);
    const deleteChunks = this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?');
    const insertChunk = this.db.prepare(`
      INSERT INTO knowledge_chunks (id, document_id, ordinal, text, source_uri, title)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertVector = this.db.prepare('INSERT INTO knowledge_chunk_vectors (chunk_id, vector_json) VALUES (?, ?)');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      insertDocument.run(document.id, document.title, document.sourceUri, document.text, document.updatedAt);
      deleteVectors.run(document.id);
      deleteChunks.run(document.id);
      for (const chunk of chunks) {
        if (chunk.documentId !== document.id) throw new Error('知识分块必须属于被替换的文档');
        insertChunk.run(chunk.id, chunk.documentId, chunk.ordinal, chunk.text, chunk.sourceUri, chunk.title);
        insertVector.run(chunk.id, JSON.stringify(vectorFor(chunk.text)));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  chunks(): readonly KnowledgeChunk[] {
    const rows = this.db.prepare(`
      SELECT id, document_id, ordinal, text, source_uri, title
      FROM knowledge_chunks ORDER BY document_id ASC, ordinal ASC
    `).all() as unknown as ChunkRow[];
    return rows.map((row) => copyChunk({
      id: row.id,
      documentId: row.document_id,
      ordinal: row.ordinal,
      text: row.text,
      sourceUri: row.source_uri,
      title: row.title,
    }));
  }

  document(documentId: string): KnowledgeDocument | undefined {
    const row = this.db.prepare(`
      SELECT id, title, source_uri, text, updated_at FROM knowledge_documents WHERE id = ?
    `).get(documentId) as DocumentRow | undefined;
    return row ? copyDocument({
      id: row.id,
      title: row.title,
      sourceUri: row.source_uri,
      text: row.text,
      updatedAt: row.updated_at,
    }) : undefined;
  }

  searchChunks(query: string, limit: number): readonly KnowledgeChunkMatch[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
    const queryVector = vectorFor(query);
    if (Object.keys(queryVector).length === 0) return [];
    const rows = this.db.prepare(`
      SELECT chunk.id, chunk.document_id, chunk.ordinal, chunk.text, chunk.source_uri, chunk.title, vector.vector_json
      FROM knowledge_chunk_vectors AS vector
      JOIN knowledge_chunks AS chunk ON chunk.id = vector.chunk_id
    `).all() as unknown as VectorRow[];
    return rows
      .map((row) => ({
        score: cosine(queryVector, JSON.parse(row.vector_json) as SparseVector),
        chunk: copyChunk({
          id: row.id,
          documentId: row.document_id,
          ordinal: row.ordinal,
          text: row.text,
          sourceUri: row.source_uri,
          title: row.title,
        }),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.documentId.localeCompare(right.chunk.documentId) || left.chunk.ordinal - right.chunk.ordinal)
      .slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
