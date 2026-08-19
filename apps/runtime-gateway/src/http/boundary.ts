import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export interface HttpRequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly segments: readonly string[];
}

/** 将 Node HTTP 输入归一化为路由只需消费的安全上下文。 */
export function createHttpRequestContext(request: IncomingMessage, response: ServerResponse): HttpRequestContext {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  return { request, response, url, segments: url.pathname.split('/').filter(Boolean).map(decodeURIComponent) };
}

/** 唯一 JSON 输出适配器；领域服务不接触 Node response 对象。 */
export function sendJson(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

/** 受限 JSON body 适配器，拒绝超过本地 Gateway 边界的请求负载。 */
export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_JSON_BODY_BYTES / 1024}KiB`));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** HTTP 适配器层统一将输入解析错误映射为 client error，其他异常保持 server error。 */
export function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  return message.includes('64KiB') || message.includes('JSON') ? 400 : 500;
}
