import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function isOperatorRequest(request: { headers: { [key: string]: string | string[] | undefined } }): boolean {
  return request.headers['x-awo-operator-intent'] === 'provider-connection-v1';
}

function readReview(body: unknown): { reviewedBy: string; note?: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'reviewedBy' && key !== 'note')) return undefined;
  if (typeof candidate.reviewedBy !== 'string' || (candidate.note !== undefined && typeof candidate.note !== 'string')) return undefined;
  return { reviewedBy: candidate.reviewedBy, note: candidate.note as string | undefined };
}

function readInference(body: unknown): { prompt: string; model?: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'prompt' && key !== 'model')) return undefined;
  if (typeof candidate.prompt !== 'string' || (candidate.model !== undefined && typeof candidate.model !== 'string')) return undefined;
  return { prompt: candidate.prompt, model: candidate.model as string | undefined };
}

/** 唯一会话密钥入口：精确白名单；baseUrl 仅可由显式连接动作提交并在 Gateway 会话内存校验、保存。 */
function readSessionConfiguration(body: unknown): { displayName?: string; model?: string; baseUrl?: string; protocol?: 'openai-compatible' | 'anthropic-compatible'; apiKey: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'displayName' && key !== 'model' && key !== 'baseUrl' && key !== 'protocol' && key !== 'apiKey')) return undefined;
  if (typeof candidate.apiKey !== 'string' || (candidate.displayName !== undefined && typeof candidate.displayName !== 'string') || (candidate.model !== undefined && typeof candidate.model !== 'string') || (candidate.baseUrl !== undefined && typeof candidate.baseUrl !== 'string') || (candidate.protocol !== undefined && candidate.protocol !== 'openai-compatible' && candidate.protocol !== 'anthropic-compatible')) return undefined;
  return { apiKey: candidate.apiKey, displayName: candidate.displayName as string | undefined, model: candidate.model as string | undefined, baseUrl: candidate.baseUrl as string | undefined, protocol: candidate.protocol as 'openai-compatible' | 'anthropic-compatible' | undefined };
}

/** custom endpoint 只在一次显式登记时接收；后续 probe/infer 只按 session providerId 调用。 */
function readCustomSessionConfiguration(body: unknown): { displayName: string; protocol: 'openai-compatible' | 'anthropic-compatible'; baseUrl: string; model: string; apiKey: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'displayName' && key !== 'protocol' && key !== 'baseUrl' && key !== 'model' && key !== 'apiKey')) return undefined;
  if (typeof candidate.displayName !== 'string' || (candidate.protocol !== 'openai-compatible' && candidate.protocol !== 'anthropic-compatible') || typeof candidate.baseUrl !== 'string' || typeof candidate.model !== 'string' || typeof candidate.apiKey !== 'string') return undefined;
  return { displayName: candidate.displayName, protocol: candidate.protocol, baseUrl: candidate.baseUrl, model: candidate.model, apiKey: candidate.apiKey };
}

function isCustomProviderId(value: string): boolean {
  return /^custom-[a-z0-9-]{8,96}$/.test(value);
}

/**
 * Provider connection 管道：Profile metadata 与 credential availability 的显式控制面。
 * 它不读取运行时环境配置。除 `configure-session` 外不接收密钥、token、URL、工具或 agent 配置；
 * `configure-session` 只接受受控 baseUrl 与 key，二者只进入 Gateway 当前进程内存且不回显。远程探测与推理均只能由 operator-intent 的显式 POST 发起。
 */
export const handleProviderConnectionRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  if (request.method === 'GET' && url.pathname === '/api/providers/connections') {
    sendJson(response, 200, [...dependencies.providerConnections.list(), ...dependencies.customProviders.list()]);
    return true;
  }
  const isCustomConfiguration = url.pathname === '/api/providers/connections/custom/configure-session';
  if (isCustomConfiguration) {
    if (request.method !== 'POST' || !isOperatorRequest(request)) {
      sendJson(response, request.method === 'POST' ? 403 : 404, { error: '自定义供应商连接必须由本地操作者显式发起' });
      return true;
    }
    try {
      const configuration = readCustomSessionConfiguration(await readJsonBody(request));
      if (!configuration) {
        sendJson(response, 400, { error: '自定义连接只接受 displayName、protocol、baseUrl、model 与 apiKey；不得提交 headers、工具或任意请求字段' });
        return true;
      }
      sendJson(response, 200, dependencies.customProviders.configureSession(configuration));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '自定义供应商连接无效' });
    }
    return true;
  }
  if (segments[0] !== 'api' || segments[1] !== 'providers' || segments[2] !== 'connections' || !segments[3] || !segments[4] || segments.length !== 5) return false;
  if (request.method !== 'POST' || !isOperatorRequest(request)) {
    sendJson(response, request.method === 'POST' ? 403 : 404, { error: '供应商连接操作必须由本地操作者显式发起' });
    return true;
  }
  const providerId = segments[3];
  const operation = segments[4];
  try {
    if (operation === 'models') {
      if (request.headers['content-length'] && request.headers['content-length'] !== '0') {
        sendJson(response, 400, { error: 'models 不接受请求正文；不会接收密钥或模型输入' });
        return true;
      }
      sendJson(response, 200, isCustomProviderId(providerId)
        ? await dependencies.customProviders.discoverModels(providerId)
        : await dependencies.providerConnections.discoverModels(providerId));
      return true;
    }
    if (operation === 'probe') {
      if (request.headers['content-length'] && request.headers['content-length'] !== '0') {
        sendJson(response, 400, { error: 'probe 不接受请求正文；不会接收密钥或模型输入' });
        return true;
      }
      sendJson(response, 200, isCustomProviderId(providerId)
        ? await dependencies.customProviders.probe(providerId)
        : await dependencies.providerConnections.probe(providerId));
      return true;
    }
    if (operation === 'infer-stream') {
      const inference = readInference(await readJsonBody(request));
      if (!inference) {
        sendJson(response, 400, { error: 'infer-stream 只接受 prompt 与可选 model；不得提交 API key、token、endpoint、工具或 agent 配置' });
        return true;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let characters = 0;
      let model: string | undefined;
      try {
        const source = isCustomProviderId(providerId)
          ? dependencies.customProviders.stream({ providerId, ...inference })
          : dependencies.providerInference.stream({ providerId, ...inference });
        for await (const chunk of source) {
          model ??= chunk.model;
          characters += chunk.text.length;
          response.write(`event: text\ndata: ${JSON.stringify({ text: chunk.text })}\n\n`);
        }
        response.write(`event: done\ndata: ${JSON.stringify({ providerId, model, outputCharacters: characters })}\n\n`);
      } catch (error) {
        response.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : '远程模型流式请求未完成' })}\n\n`);
      } finally {
        response.end();
      }
      return true;
    }
    if (operation === 'infer') {
      const inference = readInference(await readJsonBody(request));
      if (!inference) {
        sendJson(response, 400, { error: 'infer 只接受 prompt 与可选 model；不得提交 API key、token、endpoint、工具或 agent 配置' });
        return true;
      }
      const result = isCustomProviderId(providerId)
        ? await dependencies.customProviders.infer({ providerId, ...inference })
        : await dependencies.providerInference.infer({ providerId, ...inference });
      // 计量只取已经脱敏的完成结果；账本问题不得把成功模型调用转换为失败响应。
      try {
        dependencies.apiUsage.recordCompleted({
          providerId: result.providerId, profileId: result.profileId, profileRevision: result.profileRevision,
          model: result.model, dataBoundary: result.dataBoundary, latencyMs: result.latencyMs,
          outputCharacters: result.outputCharacters, recordedAt: Date.now(),
        });
      } catch { /* 计量是只读可观测性补充，不改变已完成推理的用户可见事实。 */ }
      sendJson(response, 200, result);
      return true;
    }
    if (operation === 'configure-session') {
      const configuration = readSessionConfiguration(await readJsonBody(request));
      if (!configuration) {
        sendJson(response, 400, { error: '快速配置只接受 displayName、model、baseUrl、protocol 与 apiKey；不得提交 header、工具或其他字段' });
        return true;
      }
      const status = dependencies.providerConnections.configureSession({ providerId, reviewedBy: 'desktop-owner', at: Date.now(), ...configuration });
      sendJson(response, 200, status);
      return true;
    }
    if (operation !== 'register' && operation !== 'activate') {
              sendJson(response, 404, { error: '供应商连接操作必须是 register、activate、configure-session、models、probe、infer 或 infer-stream' });

      return true;
    }
    const review = readReview(await readJsonBody(request));
    if (!review) {
      sendJson(response, 400, { error: '供应商连接变更只接受 reviewedBy 与可选 note；不得提交 API key、token 或 endpoint' });
      return true;
    }
    const at = Date.now();
    const status = operation === 'register'
      ? dependencies.providerConnections.register({ providerId, ...review, at })
      : dependencies.providerConnections.activate({ providerId, ...review, at });
    sendJson(response, operation === 'register' ? 201 : 200, status);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : '供应商连接操作无效' });
  }
  return true;
};
