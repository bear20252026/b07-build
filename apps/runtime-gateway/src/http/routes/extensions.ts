import type { DiscoverExtensionRequest, ExtensionActivationTarget, McpConnection, McpToolManifest } from '@awo/agent-runtime';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** Extension/MCP HTTP 适配器；不加载、不启动、不执行 manifest 或 MCP 连接。 */
export const handleExtensionRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  const { extensionDoctor, extensionPlanStore, extensionActivationPlanner, extensionRegistry, mcpRegistry } = dependencies;
  if (request.method === 'GET' && url.pathname === '/api/extensions/doctor') {
    sendJson(response, 200, extensionDoctor.inspect());
    return true;
  }

  if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'extensions' && segments[2] === 'plans' && segments[3] && segments[4] && segments.length === 5) {
    sendJson(response, 200, extensionPlanStore.list(segments[3], segments[4]));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/extensions/plans') {
    const body = await readJsonBody(request) as { taskId?: unknown; runId?: unknown; target?: unknown; planId?: unknown };
    if (typeof body.taskId !== 'string' || typeof body.runId !== 'string' || !body.target || typeof body.target !== 'object' || (body.planId !== undefined && typeof body.planId !== 'string')) {
      sendJson(response, 400, { error: 'extension plan 必须提供 taskId、runId、target，planId 只能为字符串' });
      return true;
    }
    try {
      const plan = extensionActivationPlanner.plan({
        taskId: body.taskId,
        runId: body.runId,
        target: body.target as ExtensionActivationTarget,
        planId: body.planId as string | undefined,
        at: Date.now(),
      });
      sendJson(response, 201, plan);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'extension plan 无效' });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/extensions') {
    sendJson(response, 200, extensionRegistry.list());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/extensions') {
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (
      typeof body.id !== 'string' || typeof body.version !== 'string' || typeof body.kind !== 'string'
      || typeof body.displayName !== 'string' || !body.source || !body.compatibility
      || !Array.isArray(body.declaredCapabilities) || !Array.isArray(body.requestedPermissions)
      || typeof body.dataBoundary !== 'string' || !body.resourceBudget
      || (body.note !== undefined && typeof body.note !== 'string')
    ) {
      sendJson(response, 400, { error: 'extension 必须提供 id、version、kind、displayName、source、compatibility、capabilities、dataBoundary 与 resourceBudget' });
      return true;
    }
    try {
      const discovered = extensionRegistry.discover({
        ...(body as unknown as Omit<DiscoverExtensionRequest, 'at'>),
        at: Date.now(),
      });
      sendJson(response, 201, discovered);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'extension manifest 无效' });
    }
    return true;
  }

  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'extensions' && segments[2] && segments[3] && segments.length === 4) {
    const operation = segments[3];
    if (operation !== 'review' && operation !== 'install' && operation !== 'disable' && operation !== 'revoke') {
      sendJson(response, 404, { error: 'extension 状态操作必须是 review、install、disable 或 revoke' });
      return true;
    }
    const body = await readJsonBody(request) as { reviewedBy?: unknown; verifiedDigest?: unknown; note?: unknown };
    if (
      typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')
      || (operation === 'install' && typeof body.verifiedDigest !== 'string')
    ) {
      sendJson(response, 400, { error: operation === 'install' ? 'extension 安装必须提供 reviewedBy 与 verifiedDigest' : 'extension 状态变更必须提供 reviewedBy' });
      return true;
    }
    try {
      const at = Date.now();
      const manifest = operation === 'review'
        ? extensionRegistry.review(segments[2], body.reviewedBy, at, body.note)
        : operation === 'install'
          ? extensionRegistry.install(segments[2], body.verifiedDigest as string, body.reviewedBy, at, body.note)
          : operation === 'disable'
            ? extensionRegistry.disable(segments[2], body.reviewedBy, at, body.note)
            : extensionRegistry.revoke(segments[2], body.reviewedBy, at, body.note);
      sendJson(response, 200, manifest);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'extension 状态变更无效' });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/mcp/servers') {
    sendJson(response, 200, mcpRegistry.list());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/mcp/servers') {
    const body = await readJsonBody(request) as {
      id?: unknown; displayName?: unknown; connection?: unknown; declaredTools?: unknown;
      sourceDigest?: unknown; reviewedBy?: unknown; note?: unknown;
    };
    if (
      typeof body.id !== 'string' || typeof body.displayName !== 'string' || !body.connection
      || !Array.isArray(body.declaredTools) || typeof body.sourceDigest !== 'string' || typeof body.reviewedBy !== 'string'
      || (body.note !== undefined && typeof body.note !== 'string')
    ) {
      sendJson(response, 400, { error: 'MCP manifest 必须提供 id、displayName、connection、declaredTools、sourceDigest 与 reviewedBy' });
      return true;
    }
    sendJson(response, 201, mcpRegistry.register({
      id: body.id, displayName: body.displayName, connection: body.connection as McpConnection,
      declaredTools: body.declaredTools as McpToolManifest[], sourceDigest: body.sourceDigest,
      reviewedBy: body.reviewedBy, note: body.note as string | undefined, at: Date.now(),
    }));
    return true;
  }

  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'mcp' && segments[2] === 'servers' && segments[3] && segments[4] && segments.length === 5) {
    const operation = segments[4];
    if (operation !== 'enable' && operation !== 'disable' && operation !== 'revoke') {
      sendJson(response, 404, { error: 'MCP 状态操作必须是 enable、disable 或 revoke' });
      return true;
    }
    const body = await readJsonBody(request) as { reviewedBy?: unknown; note?: unknown };
    if (typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) {
      sendJson(response, 400, { error: 'MCP 状态变更必须提供 reviewedBy，note 只能为字符串' });
      return true;
    }
    const at = Date.now();
    const manifest = operation === 'enable'
      ? mcpRegistry.enable(segments[3], body.reviewedBy, at, body.note)
      : operation === 'disable'
        ? mcpRegistry.disable(segments[3], body.reviewedBy, at, body.note)
        : mcpRegistry.revoke(segments[3], body.reviewedBy, at, body.note);
    sendJson(response, 200, manifest);
    return true;
  }

  return false;
};
