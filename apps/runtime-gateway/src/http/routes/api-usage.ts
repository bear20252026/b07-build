import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function readLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : undefined;
}

/** 本机 Provider 推理的只读、脱敏计量投影；没有写入、再调用或供应商账户查询能力。 */
export const handleApiUsageRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (request.method !== 'GET') return false;
  if (url.pathname === '/api/usage/summary') {
    const limit = readLimit(url.searchParams.get('limit'));
    if (url.searchParams.get('limit') !== null && limit === undefined) {
      sendJson(response, 400, { error: 'limit 必须是 1-500 的整数' });
      return true;
    }
    sendJson(response, 200, dependencies.apiUsage.summary(Date.now(), limit));
    return true;
  }
  if (url.pathname === '/api/usage/receipts') {
    const limit = readLimit(url.searchParams.get('limit'));
    if (url.searchParams.get('limit') !== null && limit === undefined) {
      sendJson(response, 400, { error: 'limit 必须是 1-500 的整数' });
      return true;
    }
    sendJson(response, 200, dependencies.apiUsage.recent(limit));
    return true;
  }
  return false;
};
