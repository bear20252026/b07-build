import { sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** Windows-only release evidence 冷路径；不接收 helper path、AuthentiCode 内容、digest、签名、证书或任何 bridge mutation。 */
export const handleWindowsNativeReleaseReportRoutes: GatewayRoute = async ({ request, response, url, dependencies }) => {
  if (url.pathname !== '/api/windows/native-release-evidence') return false;
  if (request.method !== 'GET') return false;
  sendJson(response, 200, dependencies.windowsNativeReleaseReport());
  return true;
};
