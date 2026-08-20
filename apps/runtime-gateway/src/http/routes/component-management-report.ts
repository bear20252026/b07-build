import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** 浏览器仅可观察受控本地宿主已发生的管理回执；绝不转发 attestation、意图或 mutation。 */
export const handleComponentManagementReportRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (url.pathname !== '/api/components/management-receipts') return false;
  if (request.method !== 'GET') return false;
  sendJson(response, 200, dependencies.componentManagementReport());
  return true;
};
