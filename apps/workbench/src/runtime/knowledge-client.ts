export interface CitationPreview {
  documentId: string;
  chunkId: string;
  sourceUri: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface KnowledgeSearchClient {
  search(query: string, limit?: number): Promise<readonly CitationPreview[]>;
}

function assertCitation(value: unknown): asserts value is CitationPreview {
  if (!value || typeof value !== 'object') throw new Error('知识服务返回了无效引用');
  const citation = value as Partial<CitationPreview>;
  if (
    typeof citation.documentId !== 'string' || typeof citation.chunkId !== 'string'
    || typeof citation.sourceUri !== 'string' || typeof citation.title !== 'string'
    || typeof citation.excerpt !== 'string' || typeof citation.score !== 'number'
  ) {
    throw new Error('知识服务返回了不兼容的引用格式');
  }
}

/** 浏览器端只读知识检索端口；文档摄取和向量持久化保持在本地服务可信边界内。 */
export class HttpKnowledgeSearchClient implements KnowledgeSearchClient {
  constructor(private readonly baseUrl = '/api/knowledge/search') {}

  async search(query: string, limit = 5): Promise<readonly CitationPreview[]> {
    if (!query.trim()) return [];
    const parameters = new URLSearchParams({ q: query.trim(), limit: String(limit) });
    const response = await fetch(`${this.baseUrl}?${parameters.toString()}`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(await response.text() || `知识检索请求失败 (${response.status})`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || !payload.every((item) => {
      try {
        assertCitation(item);
        return true;
      } catch {
        return false;
      }
    })) {
      throw new Error('知识服务返回了无效引用列表');
    }
    return payload;
  }
}
