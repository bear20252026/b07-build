import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** P6.2 冷路径只读报告；GET 只比对已有 metadata，绝不改写 provenance/lock 或触发构件生命周期动作。 */
export const handleComponentLockReportRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (url.pathname !== '/api/components/lock-report') return false;
  if (request.method !== 'GET') return false;
  sendJson(response, 200, dependencies.componentLockReport());
  return true;
};
