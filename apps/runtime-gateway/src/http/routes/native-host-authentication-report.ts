import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** 仅投影已持久化的 native host 认证摘要；该 HTTP 路由不接收 challenge、signature envelope 或管理 payload。 */
export const handleNativeHostAuthenticationReportRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (url.pathname !== '/api/native-host-authentication') return false;
  if (request.method !== 'GET') return false;
  sendJson(response, 200, dependencies.nativeHostAuthenticationReport());
  return true;
};
