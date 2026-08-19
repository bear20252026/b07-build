import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/**
 * 只读本地模型可观测性端点。
 * 它不会登记 endpoint、触发 probe、连接 Provider、返回 baseUrl 或泄露 credentialReference。
 */
export const handleLocalModelRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (request.method === 'GET' && url.pathname === '/api/local-models/health') {
    sendJson(response, 200, dependencies.localModelHealth.listHealth());
    return true;
  }
  return false;
};
