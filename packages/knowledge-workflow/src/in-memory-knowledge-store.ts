import type { KnowledgeChunk, KnowledgeDocument, KnowledgeStore } from './types.js';

function copyDocument(document: KnowledgeDocument): KnowledgeDocument {
  return { ...document };
}

function copyChunk(chunk: KnowledgeChunk): KnowledgeChunk {
  return { ...chunk };
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly documentsById = new Map<string, KnowledgeDocument>();
  private readonly chunksByDocumentId = new Map<string, KnowledgeChunk[]>();

  replaceDocument(document: KnowledgeDocument, chunks: readonly KnowledgeChunk[]): void {
    this.documentsById.set(document.id, copyDocument(document));
    this.chunksByDocumentId.set(document.id, chunks.map(copyChunk));
  }

  chunks(): readonly KnowledgeChunk[] {
    return [...this.chunksByDocumentId.values()].flatMap((items) => items.map(copyChunk));
  }

  document(documentId: string): KnowledgeDocument | undefined {
    const document = this.documentsById.get(documentId);
    return document ? copyDocument(document) : undefined;
  }
}
