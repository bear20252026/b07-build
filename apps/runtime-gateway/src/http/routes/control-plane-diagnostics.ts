import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** 只读 cold-path diagnostics；其工厂只投影已存在 metadata，绝不触发任何 control plane 副作用。 */
export const handleControlPlaneDiagnosticRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (url.pathname !== '/api/control-plane/diagnostics') return false;
  if (request.method !== 'GET') return false;
  // Route contract guarantees dependencies are only composition-root injected.
  const report = dependencies.controlPlaneDiagnostics();
  sendJson(response, 200, report);
  return true;
};
