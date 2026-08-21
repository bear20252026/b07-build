import type { SessionPersistenceMode } from '@awo/knowledge-workflow';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function isSessionPersistence(value: unknown): value is SessionPersistenceMode {
  return value === 'durable' || value === 'ephemeral' || value === 'incognito';
}

function documentBodyIsValid(body: { id?: unknown; title?: unknown; sourceUri?: unknown; text?: unknown; updatedAt?: unknown; persistence?: unknown; importId?: unknown; storageBudgetBytes?: unknown }): body is { id: string; title: string; sourceUri: string; text: string; updatedAt?: unknown; persistence?: unknown; importId?: unknown; storageBudgetBytes?: unknown } {
  return typeof body.id === 'string' && typeof body.title === 'string' && typeof body.sourceUri === 'string'
    && typeof body.text === 'string' && Boolean(body.id.trim()) && Boolean(body.title.trim())
    && Boolean(body.sourceUri.trim()) && Boolean(body.text.trim());
}

/** 知识工作区 HTTP 适配器；incognito 永远不进入持久知识存储或索引。 */
export const handleKnowledgeRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  const { knowledgeWorkspaces, knowledgeImports, defaultKnowledgeWorkspaceId } = dependencies;
  if (request.method === 'GET' && url.pathname === '/api/knowledge/workspaces') {
    sendJson(response, 200, knowledgeWorkspaces.list());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/knowledge/workspaces') {
    const body = await readJsonBody(request) as { id?: unknown; title?: unknown; description?: unknown };
    if (typeof body.id !== 'string' || typeof body.title !== 'string' || (body.description !== undefined && typeof body.description !== 'string')) {
      sendJson(response, 400, { error: '知识工作区必须具有有效 id、title，description 只能为字符串' });
      return true;
    }
    sendJson(response, 201, knowledgeWorkspaces.create({ id: body.id, title: body.title, description: body.description, at: Date.now() }));
    return true;
  }

  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'knowledge' && segments[2] === 'workspaces' && segments[3] && segments[4] === 'documents' && segments.length === 5) {
    const body = await readJsonBody(request) as { id?: unknown; title?: unknown; sourceUri?: unknown; text?: unknown; updatedAt?: unknown; persistence?: unknown; importId?: unknown; storageBudgetBytes?: unknown };
    if (!documentBodyIsValid(body)) {
      sendJson(response, 400, { error: '知识文档必须具有非空 id、title、sourceUri 与 text' });
      return true;
    }
    const persistence = body.persistence === undefined ? 'durable' : body.persistence;
    if (!isSessionPersistence(persistence)) {
      sendJson(response, 400, { error: 'persistence 必须是 durable、ephemeral 或 incognito' });
      return true;
    }
    if (persistence === 'incognito') {
      sendJson(response, 403, { error: 'incognito 会话不得摄取、索引或读取持久知识工作区' });
      return true;
    }
    const at = typeof body.updatedAt === 'number' ? body.updatedAt : Date.now();
    const requestedStorageBudget = body.storageBudgetBytes === undefined ? 100 * 1024 * 1024 : body.storageBudgetBytes;
    if (typeof requestedStorageBudget !== 'number' || !Number.isSafeInteger(requestedStorageBudget) || requestedStorageBudget < 1) {
      sendJson(response, 400, { error: 'storageBudgetBytes 必须是正安全整数' });
      return true;
    }
    const storageBudgetBytes = requestedStorageBudget;
    const importId = typeof body.importId === 'string' ? body.importId : `import:${body.id.trim()}:${at}`;
    let receipt;
    try {
      receipt = knowledgeImports.start({
        importId, workspaceId: segments[3], documentId: body.id.trim(), title: body.title.trim(), sourceUri: body.sourceUri.trim(),
        text: body.text.trim(), storageBudgetBytes, at,
      });
      const chunks = knowledgeWorkspaces.ingest({
        workspaceId: segments[3], persistence,
        document: { id: body.id.trim(), title: body.title.trim(), sourceUri: body.sourceUri.trim(), text: body.text.trim(), updatedAt: at },
      });
      const completed = knowledgeImports.complete(receipt.importId, chunks.length, Date.now());
      sendJson(response, 201, {
        workspaceId: segments[3], documentId: body.id.trim(), chunks: chunks.length,
        import: { importId: completed.importId, status: completed.status, contentDigest: completed.contentDigest, declaredBytes: completed.declaredBytes, chunkCount: completed.chunkCount },
      });
    } catch (error) {
      if (receipt?.status === 'staged') {
        try { knowledgeImports.fail(receipt.importId, 'index_failed', Date.now()); } catch { /* 保留原始错误；失败收据为 best-effort。 */ }
      }
      sendJson(response, 422, { error: error instanceof Error ? error.message : '知识导入未完成' });
    }
    return true;
  }

  if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'knowledge' && segments[2] === 'workspaces' && segments[3] && segments[4] === 'retrieve' && segments.length === 5) {
    const persistence = url.searchParams.get('persistence') ?? 'durable';
    if (!isSessionPersistence(persistence)) {
      sendJson(response, 400, { error: 'persistence 必须是 durable、ephemeral 或 incognito' });
      return true;
    }
    if (persistence === 'incognito') {
      sendJson(response, 403, { error: 'incognito 会话不得摄取、索引或读取持久知识工作区' });
      return true;
    }
    const mode = url.searchParams.get('mode') ?? 'focused';
    const requestedMaxTokens = Number(url.searchParams.get('maxTokens') ?? 4_000);
    if (!Number.isInteger(requestedMaxTokens) || requestedMaxTokens < 0 || requestedMaxTokens > 32_768) {
      sendJson(response, 400, { error: 'maxTokens 必须是 0-32768 的整数' });
      return true;
    }
    if (mode === 'full_context') {
      const documentId = url.searchParams.get('documentId');
      if (!documentId) {
        sendJson(response, 400, { error: 'full_context 检索必须提供 documentId' });
        return true;
      }
      sendJson(response, 200, knowledgeWorkspaces.retrieve({ workspaceId: segments[3], persistence, mode, documentId, at: Date.now(), maxTokens: requestedMaxTokens }));
      return true;
    }
    if (mode !== 'focused') {
      sendJson(response, 400, { error: 'mode 必须是 focused 或 full_context' });
      return true;
    }
    const query = url.searchParams.get('q') ?? '';
    const requestedLimit = Number(url.searchParams.get('limit') ?? 5);
    const maxResults = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 20 ? requestedLimit : 5;
    sendJson(response, 200, knowledgeWorkspaces.retrieve({ workspaceId: segments[3], persistence, mode, query, at: Date.now(), maxResults, maxTokens: requestedMaxTokens }));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/knowledge/documents') {
    const body = await readJsonBody(request) as { id?: unknown; title?: unknown; sourceUri?: unknown; text?: unknown; updatedAt?: unknown };
    if (!documentBodyIsValid(body)) {
      sendJson(response, 400, { error: '知识文档必须具有非空 id、title、sourceUri 与 text' });
      return true;
    }
    const chunks = knowledgeWorkspaces.ingest({
      workspaceId: defaultKnowledgeWorkspaceId, persistence: 'durable',
      document: { id: body.id.trim(), title: body.title.trim(), sourceUri: body.sourceUri.trim(), text: body.text.trim(), updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now() },
    });
    sendJson(response, 201, { documentId: body.id.trim(), chunks: chunks.length });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/knowledge/search') {
    const query = url.searchParams.get('q') ?? '';
    if (!query.trim()) {
      sendJson(response, 200, []);
      return true;
    }
    const requestedLimit = Number(url.searchParams.get('limit') ?? 5);
    const maxResults = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 20 ? requestedLimit : 5;
    const retrieval = knowledgeWorkspaces.retrieve({ workspaceId: defaultKnowledgeWorkspaceId, persistence: 'durable', mode: 'focused', query, at: Date.now(), maxResults, maxTokens: 4_000 });
    sendJson(response, 200, retrieval.results.map((result) => ({ ...result.citation, score: result.score })));
    return true;
  }

  return false;
};
