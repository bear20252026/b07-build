import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/**
 * Security Posture Audit 是冷路径只读审查：每次 GET 只重算既有 metadata 的 finding，
 * 不写审计账本、不探测端点、不执行恢复演练，也不修复、签发或加载组件。
 */
export const handleSecurityPostureAuditRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (url.pathname !== '/api/security-posture/audit') return false;
  if (request.method !== 'GET') return false;
  sendJson(response, 200, dependencies.securityPostureAudit());
  return true;
};
