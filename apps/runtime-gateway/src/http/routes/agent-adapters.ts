import type { AgentAdapterHandshakeRequest, AgentAdapterManifestV1, RegisterAgentAdapterRequest } from '@awo/agent-runtime';
import type { CapabilityPolicyRule } from '@awo/protocol';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** connectionRef 只是受控宿主引用；列表 DTO 不返回启动命令、环境或认证材料。 */
function adapterSummary(manifest: AgentAdapterManifestV1): AgentAdapterManifestV1 {
  return { ...manifest, source: { ...manifest.source }, protocol: {
    ...manifest.protocol,
    supportedVersions: [...manifest.protocol.supportedVersions],
    declaredAgentCapabilities: [...manifest.protocol.declaredAgentCapabilities],
    requestedHostCapabilities: [...manifest.protocol.requestedHostCapabilities],
  } };
}

/** Agent Adapter metadata 与审批桥 HTTP 适配器；没有 transport spawn 或 execute 入口。 */
export const handleAgentAdapterRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  const { agentAdapters } = dependencies;
  if (request.method === 'GET' && url.pathname === '/api/agent-adapters') {
    sendJson(response, 200, agentAdapters.listManifests().map(adapterSummary));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/agent-adapters') {
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (typeof body.id !== 'string' || typeof body.version !== 'string' || typeof body.displayName !== 'string' || !body.source || !body.protocol || typeof body.dataBoundary !== 'string' || typeof body.connectionRef !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) {
      sendJson(response, 400, { error: 'Agent Adapter 候选必须提供 id、version、displayName、source、protocol、dataBoundary 与 connectionRef' });
      return true;
    }
    try {
      sendJson(response, 201, adapterSummary(agentAdapters.registerCandidate({ ...(body as unknown as Omit<RegisterAgentAdapterRequest, 'at'>), at: Date.now() })));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Agent Adapter 候选无效' });
    }
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/agent-adapters/sessions') {
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (typeof body.adapterId !== 'string' || typeof body.adapterSessionId !== 'string' || typeof body.parentTaskId !== 'string' || typeof body.parentRunId !== 'string' || typeof body.agentSessionId !== 'string' || typeof body.transport !== 'string' || typeof body.protocolVersion !== 'string' || !Array.isArray(body.offeredCapabilities)) {
      sendJson(response, 400, { error: 'Adapter handshake 必须提供 adapterId、独立 adapterSessionId、父 task/run、外部 agentSessionId、transport、protocolVersion 与 offeredCapabilities' });
      return true;
    }
    try {
      sendJson(response, 201, agentAdapters.negotiate({ ...(body as unknown as Omit<AgentAdapterHandshakeRequest, 'at'>), at: Date.now() }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Adapter handshake 无效' });
    }
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/agent-adapters/sessions') {
    const taskId = url.searchParams.get('taskId');
    const runId = url.searchParams.get('runId');
    if (!taskId || !runId) {
      sendJson(response, 400, { error: '查询 Adapter sessions 必须提供 taskId 与 runId' });
      return true;
    }
    try {
      sendJson(response, 200, agentAdapters.listSessions(taskId, runId));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Adapter sessions 查询无效' });
    }
    return true;
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] === 'sessions' && segments[3] && segments[4] === 'bridge' && segments.length === 5) {
    const body = await readJsonBody(request) as { mode?: unknown };
    if (body.mode !== 'read-only' && body.mode !== 'approval-required') {
      sendJson(response, 400, { error: 'Adapter bridge mode 必须是 read-only 或 approval-required' });
      return true;
    }
    try {
      sendJson(response, 200, agentAdapters.openBridge({ adapterSessionId: segments[3], mode: body.mode, at: Date.now() }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Adapter bridge 无效' });
    }
    return true;
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] === 'sessions' && segments[3] && segments[4] === 'read-only-intents' && segments.length === 5) {
    const body = await readJsonBody(request) as { intentId?: unknown; capability?: unknown; summary?: unknown };
    if (typeof body.intentId !== 'string' || typeof body.capability !== 'string' || typeof body.summary !== 'string') {
      sendJson(response, 400, { error: '只读 Adapter intent 必须提供 intentId、capability 与 summary' });
      return true;
    }
    try {
      sendJson(response, 201, agentAdapters.proposeReadOnlyIntent({ adapterSessionId: segments[3], intentId: body.intentId, capability: body.capability as 'document.parse' | 'model.chat' | 'filesystem.read', summary: body.summary, at: Date.now() }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '只读 Adapter intent 无效' });
    }
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/agent-adapters/mailbox') {
    const taskId = url.searchParams.get('taskId') ?? undefined;
    const runId = url.searchParams.get('runId') ?? undefined;
    try {
      sendJson(response, 200, agentAdapters.listMailbox(taskId, runId));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Adapter mailbox 查询无效' });
    }
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/agent-adapters/mailbox') {
    const body = await readJsonBody(request) as { mailboxId?: unknown; adapterSessionId?: unknown; intentId?: unknown; capability?: unknown; summary?: unknown };
    if (typeof body.mailboxId !== 'string' || typeof body.adapterSessionId !== 'string' || typeof body.intentId !== 'string' || typeof body.capability !== 'string' || typeof body.summary !== 'string') {
      sendJson(response, 400, { error: 'Adapter mailbox 必须提供 mailboxId、adapterSessionId、intentId、capability 与 summary' });
      return true;
    }
    try {
      sendJson(response, 201, agentAdapters.proposeApproval({ mailboxId: body.mailboxId, adapterSessionId: body.adapterSessionId, intentId: body.intentId, capability: body.capability as CapabilityPolicyRule['capability'], summary: body.summary, at: Date.now() }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Adapter mailbox 无效' });
    }
    return true;
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] === 'mailbox' && segments[3] && segments[4] && segments.length === 5) {
    const operation = segments[4];
    if (operation !== 'approve' && operation !== 'deny' && operation !== 'expire') {
      sendJson(response, 404, { error: 'Adapter mailbox 操作必须是 approve、deny 或 expire' });
      return true;
    }
    const body = await readJsonBody(request) as { reviewedBy?: unknown; note?: unknown };
    if ((operation !== 'expire' && typeof body.reviewedBy !== 'string') || (body.note !== undefined && typeof body.note !== 'string')) {
      sendJson(response, 400, { error: operation === 'expire' ? 'Adapter mailbox expire 的 note 只能为字符串' : 'Adapter mailbox 决定必须提供 reviewedBy，note 只能为字符串' });
      return true;
    }
    try {
      const item = operation === 'approve' ? agentAdapters.approveMailbox(segments[3], body.reviewedBy as string, Date.now(), body.note) : operation === 'deny' ? agentAdapters.denyMailbox(segments[3], body.reviewedBy as string, Date.now(), body.note) : agentAdapters.expireMailbox(segments[3], Date.now(), body.note);
      sendJson(response, 200, item);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Adapter mailbox 操作无效' });
    }
    return true;
  }
  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] && segments[3] && segments.length === 4) {
    const operation = segments[3];
    if (operation !== 'review' && operation !== 'disable' && operation !== 'revoke') {
      sendJson(response, 404, { error: 'Agent Adapter 操作必须是 review、disable 或 revoke' });
      return true;
    }
    const body = await readJsonBody(request) as { reviewedBy?: unknown; verifiedDigest?: unknown; note?: unknown };
    if (typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string') || (operation === 'review' && typeof body.verifiedDigest !== 'string')) {
      sendJson(response, 400, { error: operation === 'review' ? 'Agent Adapter review 必须提供 reviewedBy 与 verifiedDigest' : 'Agent Adapter 状态变更必须提供 reviewedBy' });
      return true;
    }
    try {
      const manifest = operation === 'review' ? agentAdapters.review(segments[2], body.verifiedDigest as string, body.reviewedBy, Date.now(), body.note) : operation === 'disable' ? agentAdapters.disable(segments[2], body.reviewedBy, Date.now(), body.note) : agentAdapters.revoke(segments[2], body.reviewedBy, Date.now(), body.note);
      sendJson(response, 200, adapterSummary(manifest));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Agent Adapter 状态变更无效' });
    }
    return true;
  }
  return false;
};
