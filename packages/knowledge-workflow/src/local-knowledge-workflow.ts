import type {
  KnowledgeChunk,
  KnowledgeCitation,
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeStore,
} from './types.js';

export interface KnowledgeIngestRequest {
  document: KnowledgeDocument;
  maxChunkCharacters?: number;
}

const DEFAULT_MAX_CHUNK_CHARACTERS = 1_200;

function normalizedTerms(value: string): readonly string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function makeChunks(document: KnowledgeDocument, maxCharacters: number): readonly KnowledgeChunk[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 128) {
    throw new Error('maxChunkCharacters 必须是不小于 128 的整数');
  }
  const paragraphs = document.text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const groups: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      if (current) groups.push(current);
      current = '';
      for (let offset = 0; offset < paragraph.length; offset += maxCharacters) {
        groups.push(paragraph.slice(offset, offset + maxCharacters));
      }
      continue;
    }
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxCharacters && current) {
      groups.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }
  if (current) groups.push(current);
  return groups.map((text, ordinal) => ({
    id: `${document.id}:chunk:${ordinal}`,
    documentId: document.id,
    ordinal,
    text,
    sourceUri: document.sourceUri,
    title: document.title,
  }));
}

function citation(chunk: KnowledgeChunk): KnowledgeCitation {
  return {
    documentId: chunk.documentId,
    chunkId: chunk.id,
    sourceUri: chunk.sourceUri,
    title: chunk.title,
    excerpt: chunk.text.slice(0, 240),
  };
}

/**
 * 纯本地、无网络、无模型调用的知识工作流。上层受控工具负责 document.parse 授权；
 * 本类只接受已解析的文本，按稳定词法评分返回带来源的片段，避免生成无法归因的“知识”。
 */
export class LocalKnowledgeWorkflow {
  constructor(private readonly store: KnowledgeStore) {}

  ingest(request: KnowledgeIngestRequest): readonly KnowledgeChunk[] {
    const { document } = request;
    if (!document.id || !document.title || !document.sourceUri || !document.text.trim()) {
      throw new Error('知识文档必须具有 id、title、sourceUri 和非空文本');
    }
    const chunks = makeChunks(document, request.maxChunkCharacters ?? DEFAULT_MAX_CHUNK_CHARACTERS);
    this.store.replaceDocument({ ...document, text: document.text.trim() }, chunks);
    return chunks.map((chunk) => ({ ...chunk }));
  }

  search(query: string, limit = 5): readonly KnowledgeSearchResult[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是正整数');
    const terms = normalizedTerms(query);
    if (terms.length === 0) return [];
    const matches = this.store.chunks().flatMap((chunk) => {
      const lower = chunk.text.toLocaleLowerCase();
      const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
      return score === 0 ? [] : [{ chunk, score, citation: citation(chunk) }];
    });
    return matches
      .sort((left, right) => right.score - left.score || left.chunk.documentId.localeCompare(right.chunk.documentId) || left.chunk.ordinal - right.chunk.ordinal)
      .slice(0, limit);
  }
}
