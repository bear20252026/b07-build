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

/** 唯一会话密钥入口：精确白名单，不接受 endpoint、headers、工具、Profile 或任意扩展字段。 */
function readSessionConfiguration(body: unknown): { displayName?: string; model?: string; apiKey: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'displayName' && key !== 'model' && key !== 'apiKey')) return undefined;
  if (typeof candidate.apiKey !== 'string' || (candidate.displayName !== undefined && typeof candidate.displayName !== 'string') || (candidate.model !== undefined && typeof candidate.model !== 'string')) return undefined;
  return { apiKey: candidate.apiKey, displayName: candidate.displayName as string | undefined, model: candidate.model as string | undefined };
}

/**
 * Provider connection 管道：Profile metadata 与 credential availability 的显式控制面。
 * 它不读取运行时环境配置。除 `configure-session` 外不接收密钥、token、URL、工具或 agent 配置；
 * `configure-session` 的 key 只进入 Gateway 当前进程内存且不回显。远程探测与推理均只能由 operator-intent 的显式 POST 发起。
 */
export const handleProviderConnectionRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  if (request.method === 'GET' && url.pathname === '/api/providers/connections') {
    sendJson(response, 200, dependencies.providerConnections.list());
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
    if (operation === 'probe') {
      if (request.headers['content-length'] && request.headers['content-length'] !== '0') {
        sendJson(response, 400, { error: 'probe 不接受请求正文；不会接收密钥或模型输入' });
        return true;
      }
      sendJson(response, 200, await dependencies.providerConnections.probe(providerId));
      return true;
    }
    if (operation === 'infer') {
      const inference = readInference(await readJsonBody(request));
      if (!inference) {
        sendJson(response, 400, { error: 'infer 只接受 prompt 与可选 model；不得提交 API key、token、endpoint、工具或 agent 配置' });
        return true;
      }
      sendJson(response, 200, await dependencies.providerInference.infer({ providerId, ...inference }));
      return true;
    }
    if (operation === 'configure-session') {
      const configuration = readSessionConfiguration(await readJsonBody(request));
      if (!configuration) {
        sendJson(response, 400, { error: '快速配置只接受 displayName、model 与 apiKey；不得提交 endpoint、header、工具或其他字段' });
        return true;
      }
      const status = dependencies.providerConnections.configureSession({ providerId, reviewedBy: 'desktop-owner', at: Date.now(), ...configuration });
      sendJson(response, 200, status);
      return true;
    }
    if (operation !== 'register' && operation !== 'activate') {
      sendJson(response, 404, { error: '供应商连接操作必须是 register、activate、configure-session、probe 或 infer' });
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
