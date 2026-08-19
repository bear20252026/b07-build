export interface KnowledgeDocument {
  id: string;
  title: string;
  sourceUri: string;
  text: string;
  updatedAt: number;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  ordinal: number;
  text: string;
  sourceUri: string;
  title: string;
}

export interface KnowledgeCitation {
  documentId: string;
  chunkId: string;
  sourceUri: string;
  title: string;
  excerpt: string;
}

export interface KnowledgeSearchResult {
  chunk: KnowledgeChunk;
  score: number;
  citation: KnowledgeCitation;
}

/** 索引适配器向工作流返回的原始命中；引用仍由领域层统一构造。 */
export interface KnowledgeChunkMatch {
  chunk: KnowledgeChunk;
  score: number;
}

/**
 * 可选索引能力。`KnowledgeStore` 仍可只提供内存遍历；具备 FTS/向量索引的 adapter 可实现此端口。
 */
export interface SearchableKnowledgeStore extends KnowledgeStore {
  searchChunks(query: string, limit: number): readonly KnowledgeChunkMatch[];
}

/**
 * 本地知识存储端口。实现可采用内存、SQLite FTS、向量库或远程索引，但工作流只依赖该最小集合。
 */
export interface KnowledgeStore {
  replaceDocument(document: KnowledgeDocument, chunks: readonly KnowledgeChunk[]): void;
  chunks(): readonly KnowledgeChunk[];
  document(documentId: string): KnowledgeDocument | undefined;
}
