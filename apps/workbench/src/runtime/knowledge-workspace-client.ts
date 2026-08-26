export interface WorkbenchKnowledgeWorkspace {
  readonly id: string;
  readonly title: string;
  readonly status: 'active' | 'archived';
}

export interface WorkbenchKnowledgeImportReceipt {
  readonly importId: string;
  readonly status: 'indexed';
  readonly contentDigest: string;
  readonly declaredBytes: number;
  readonly chunkCount: number;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 响应格式无效`);
  return value as Record<string, unknown>;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = expectObject(body, '知识服务');
    throw new Error(typeof error.error === 'string' ? error.error : '知识请求未完成');
  }
  return body;
}

/** Workbench 只发出用户显式的知识服务意图；不读取文件、不上传文件，也不持久化正文。 */
export class HttpKnowledgeWorkspaceClient {
  constructor(private readonly baseUrl = '') {}

  async listWorkspaces(): Promise<readonly WorkbenchKnowledgeWorkspace[]> {
    const body = await requestJson(`${this.baseUrl}/api/knowledge/workspaces`);
    if (!Array.isArray(body)) throw new Error('知识工作区列表格式无效');
    return body.map((value) => {
      const item = expectObject(value, '知识工作区');
      if (typeof item.id !== 'string' || typeof item.title !== 'string' || (item.status !== 'active' && item.status !== 'archived')) throw new Error('知识工作区字段无效');
      return { id: item.id, title: item.title, status: item.status };
    });
  }

  async importText(input: { workspaceId: string; importId: string; documentId: string; title: string; sourceUri: string; text: string; storageBudgetBytes: number }): Promise<WorkbenchKnowledgeImportReceipt> {
    const body = expectObject(await requestJson(`${this.baseUrl}/api/knowledge/workspaces/${encodeURIComponent(input.workspaceId)}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'knowledge.import-text' },
      body: JSON.stringify({ ...input, persistence: 'durable', updatedAt: Date.now() }),
    }), '知识导入');
    const receipt = expectObject(body.import, '知识导入收据');
    if (typeof receipt.importId !== 'string' || receipt.status !== 'indexed' || typeof receipt.contentDigest !== 'string' || typeof receipt.declaredBytes !== 'number' || typeof receipt.chunkCount !== 'number') {
      throw new Error('知识导入收据字段无效');
    }
    return { importId: receipt.importId, status: 'indexed', contentDigest: receipt.contentDigest, declaredBytes: receipt.declaredBytes, chunkCount: receipt.chunkCount };
  }
}
