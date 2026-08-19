import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentProfileId, CapabilityPolicyRule, TaskEvent } from '@awo/protocol';
import {
  InMemoryApprovalPort,
  LocalTaskRuntimeService,
  RuleBasedCapabilityPolicy,
  SqliteTaskSnapshotStore,
  SqliteTaskCommandReceiptStore,
  ReadOnlySubtaskService,
  SqliteSubtaskSnapshotStore,
  McpRegistry,
  SqliteMcpManifestStore,
  ExtensionRegistry,
  SqliteExtensionManifestStore,
  ExtensionActivationPlanner,
  ExtensionDoctor,
  AgentAdapterControlPlane,
  SqliteAdapterApprovalMailboxStore,
  SqliteAgentAdapterManifestStore,
  SqliteAgentAdapterSessionStore,
  SqliteExtensionPlanStore,
  type DiscoverExtensionRequest,
  type ExtensionActivationTarget,
  type McpConnection,
  type McpToolManifest,
  type AgentAdapterHandshakeRequest,
  type AgentAdapterManifestV1,
  type DAGNode,
  type RegisterAgentAdapterRequest,
  type TaskRuntimeRequest,
} from '@awo/agent-runtime';
import {
  ProviderProfileRegistry,
  SqliteProviderProfileStore,
  type RegisterProviderProfileRequest,
  type UpdateProviderProfileRequest,
} from '@awo/provider-sdk';
import {
  KnowledgeWorkspaceService,
  SkillPackRegistry,
  SqliteKnowledgeWorkspaceStore,
  SqliteSkillPackStore,
  SqliteWorkspaceKnowledgeStoreFactory,
  type RegisterSkillPackCandidateRequest,
  type SessionPersistenceMode,
  type SkillPackManifestV1,
} from '@awo/knowledge-workflow';

const PORT = Number(process.env.AWO_RUNTIME_PORT ?? 4318);
const SNAPSHOT_PATH = resolve(process.env.AWO_SNAPSHOT_DB ?? '.awo/task-snapshots.sqlite');
const KNOWLEDGE_WORKSPACE_PATH = resolve(process.env.AWO_KNOWLEDGE_WORKSPACE_DB ?? '.awo/knowledge-workspaces.sqlite');
const KNOWLEDGE_WORKSPACE_DIR = resolve(process.env.AWO_KNOWLEDGE_WORKSPACE_DIR ?? '.awo/knowledge-workspaces');
const RECEIPT_PATH = resolve(process.env.AWO_RECEIPT_DB ?? '.awo/task-command-receipts.sqlite');
const SUBTASK_PATH = resolve(process.env.AWO_SUBTASK_DB ?? '.awo/read-only-subtasks.sqlite');
const MCP_MANIFEST_PATH = resolve(process.env.AWO_MCP_MANIFEST_DB ?? '.awo/mcp-manifests.sqlite');
const EXTENSION_MANIFEST_PATH = resolve(process.env.AWO_EXTENSION_MANIFEST_DB ?? '.awo/extension-manifests.sqlite');
const EXTENSION_PLAN_PATH = resolve(process.env.AWO_EXTENSION_PLAN_DB ?? '.awo/extension-plans.sqlite');
const PROVIDER_PROFILE_PATH = resolve(process.env.AWO_PROVIDER_PROFILE_DB ?? '.awo/provider-profiles.sqlite');
const SKILL_PACK_PATH = resolve(process.env.AWO_SKILL_PACK_DB ?? '.awo/skill-packs.sqlite');
const AGENT_ADAPTER_MANIFEST_PATH = resolve(process.env.AWO_AGENT_ADAPTER_MANIFEST_DB ?? '.awo/agent-adapters.sqlite');
const AGENT_ADAPTER_SESSION_PATH = resolve(process.env.AWO_AGENT_ADAPTER_SESSION_DB ?? '.awo/agent-adapter-sessions.sqlite');
const AGENT_ADAPTER_MAILBOX_PATH = resolve(process.env.AWO_AGENT_ADAPTER_MAILBOX_DB ?? '.awo/agent-adapter-mailbox.sqlite');
const store = new SqliteTaskSnapshotStore(SNAPSHOT_PATH);
const knowledgeWorkspaceStore = new SqliteKnowledgeWorkspaceStore(KNOWLEDGE_WORKSPACE_PATH);
const knowledgeStoreFactory = new SqliteWorkspaceKnowledgeStoreFactory(KNOWLEDGE_WORKSPACE_DIR);
const knowledgeWorkspaces = new KnowledgeWorkspaceService(knowledgeWorkspaceStore, knowledgeStoreFactory);
const commandReceipts = new SqliteTaskCommandReceiptStore(RECEIPT_PATH);
const subtaskStore = new SqliteSubtaskSnapshotStore(SUBTASK_PATH);
const readOnlySubtasks = new ReadOnlySubtaskService(subtaskStore);
const mcpManifestStore = new SqliteMcpManifestStore(MCP_MANIFEST_PATH);
const mcpRegistry = new McpRegistry(mcpManifestStore);
const extensionManifestStore = new SqliteExtensionManifestStore(EXTENSION_MANIFEST_PATH);
const extensionRegistry = new ExtensionRegistry(extensionManifestStore);
const extensionPlanStore = new SqliteExtensionPlanStore(EXTENSION_PLAN_PATH);
const providerProfileStore = new SqliteProviderProfileStore(PROVIDER_PROFILE_PATH);
const providerProfiles = new ProviderProfileRegistry(providerProfileStore);
const skillPackStore = new SqliteSkillPackStore(SKILL_PACK_PATH);
const skillPacks = new SkillPackRegistry(skillPackStore);
const agentAdapterManifestStore = new SqliteAgentAdapterManifestStore(AGENT_ADAPTER_MANIFEST_PATH);
const agentAdapterSessionStore = new SqliteAgentAdapterSessionStore(AGENT_ADAPTER_SESSION_PATH);
const agentAdapterMailboxStore = new SqliteAdapterApprovalMailboxStore(AGENT_ADAPTER_MAILBOX_PATH);
const agentAdapters = new AgentAdapterControlPlane(agentAdapterManifestStore, agentAdapterSessionStore, agentAdapterMailboxStore);
const DEFAULT_KNOWLEDGE_WORKSPACE_ID = 'default-local';
if (!knowledgeWorkspaceStore.load(DEFAULT_KNOWLEDGE_WORKSPACE_ID)) {
  knowledgeWorkspaces.create({
    id: DEFAULT_KNOWLEDGE_WORKSPACE_ID,
    title: '默认本地知识库',
    description: '为兼容本地工作台知识检索创建的受控默认工作区。',
    at: Date.now(),
  });
}
const runtime = new LocalTaskRuntimeService(store);
const requests = new Map<string, TaskRuntimeRequest>();
const eventsByRun = new Map<string, TaskEvent[]>();
const approvedActions = new Set<string>();

const BASELINE_RULES: readonly CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: '本地任务模板允许文档解析' },
  { capability: 'model.chat', decision: 'allow', reason: '本地任务模板允许受控模型推理' },
  { capability: 'filesystem.read', decision: 'allow', reason: '本地任务模板允许只读检查' },
  { capability: 'filesystem.write', decision: 'require_approval', reason: '写入意图必须经本地审批' },
  { capability: 'network.fetch', decision: 'require_approval', reason: '网络访问必须经本地审批' },
  { capability: 'shell.execute', decision: 'require_approval', reason: 'Shell 执行必须经本地审批' },
  { capability: 'browser.control', decision: 'require_approval', reason: '浏览器控制必须经本地审批' },
];
const extensionActivationPlanner = new ExtensionActivationPlanner(
  extensionRegistry,
  new RuleBasedCapabilityPolicy(BASELINE_RULES),
  extensionPlanStore,
);
const extensionDoctor = new ExtensionDoctor(extensionRegistry);

function runKey(taskId: string, runId: string): string {
  return `${taskId}:${runId}`;
}

function isProfileId(value: unknown): value is AgentProfileId {
  return value === 'build' || value === 'plan' || value === 'explore';
}

function isSessionPersistence(value: unknown): value is SessionPersistenceMode {
  return value === 'durable' || value === 'ephemeral' || value === 'incognito';
}

function isReadOnlySubtaskRole(value: unknown): value is 'explore' | 'scout' {
  return value === 'explore' || value === 'scout';
}

function event(type: TaskEvent['type'], taskId: string, runId: string, payload: Record<string, unknown>): TaskEvent {
  return {
    protocolVersion: '1.0',
    eventId: `gateway:${runId}:${type}:${randomUUID()}`,
    taskId,
    runId,
    at: Date.now(),
    type,
    ...payload,
  } as TaskEvent;
}

function taskNodes(profileId: AgentProfileId): readonly DAGNode[] {
  const readOnly = [
    {
      id: 'understand',
      kind: 'model' as const,
      tool: { name: 'local.task.understand', args: {}, capability: 'model.chat' as const, risk: 'low' as const },
      idempotencyKey: 'understand:v1',
      deps: [],
    },
    {
      id: 'inspect',
      kind: 'tool' as const,
      tool: { name: 'workspace.inspect', args: {}, capability: 'filesystem.read' as const, risk: 'low' as const },
      idempotencyKey: 'inspect:v1',
      deps: ['understand'],
    },
  ];
  if (profileId !== 'build') return readOnly;
  return [
    ...readOnly,
    {
      id: 'deliver',
      kind: 'tool',
      tool: { name: 'workspace.write.intent', args: {}, capability: 'filesystem.write', risk: 'medium' },
      idempotencyKey: 'deliver:v1',
      deps: ['inspect'],
    },
  ];
}

function createRequest(
  goal: string,
  profileId: AgentProfileId,
  identity: { taskId: string; runId: string } = { taskId: `task-${randomUUID()}`, runId: `run-${randomUUID()}` },
): TaskRuntimeRequest {
  const { taskId, runId } = identity;
  const existingEvents = eventsByRun.get(runKey(taskId, runId));
  const events: TaskEvent[] = existingEvents ?? [
    event('task.created', taskId, runId, { goal }),
    event('agent.profile.selected', taskId, runId, { profileId }),
    event('plan.proposed', taskId, runId, {
      steps: taskNodes(profileId).map((node) => ({ id: node.id, description: node.tool.name, risk: node.tool.risk })),
    }),
  ];
  const request: TaskRuntimeRequest = {
    taskId,
    runId,
    goal,
    profileId,
    nodes: taskNodes(profileId),
    baselinePolicy: new RuleBasedCapabilityPolicy(BASELINE_RULES),
    approvals: new InMemoryApprovalPort(approvedActions),
    runner: {
      async run(node) {
        // 网关模板只证明端到端控制路径；不会修改文件、调用网络或执行 Shell。
        return { ok: true, outputRef: `local://task/${taskId}/${node.id}` };
      },
    },
    emit(nextEvent) {
      events.push(nextEvent);
    },
  };
  eventsByRun.set(runKey(taskId, runId), events);
  return request;
}

function commandFingerprint(command: string, fields: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify({ command, ...fields })).digest('hex');
}

function idempotencyKey(request: IncomingMessage): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

/** 浏览器控制面只读展示审计 metadata；Skill Pack 正文仅能由服务器在显式上下文装配时消费。 */
function skillPackSummary(manifest: SkillPackManifestV1): Omit<SkillPackManifestV1, 'content'> {
  const { content: _content, ...summary } = manifest;
  return summary;
}

/** Adapter manifest 的 connectionRef 只是受控宿主引用；路由不返回任何实际启动命令、环境或认证材料。 */
function agentAdapterSummary(manifest: AgentAdapterManifestV1): AgentAdapterManifestV1 {
  return { ...manifest, source: { ...manifest.source }, protocol: {
    ...manifest.protocol,
    supportedVersions: [...manifest.protocol.supportedVersions],
    declaredAgentCapabilities: [...manifest.protocol.declaredAgentCapabilities],
    requestedHostCapabilities: [...manifest.protocol.requestedHostCapabilities],
  } };
}

function jsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 64 * 1024) {
        reject(new Error('request body exceeds 64KiB'));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (request.method === 'GET' && url.pathname === '/api/agent-adapters') {
      send(response, 200, agentAdapters.listManifests().map(agentAdapterSummary));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent-adapters') {
      const body = await jsonBody(request) as Record<string, unknown>;
      if (
        typeof body.id !== 'string' || typeof body.version !== 'string' || typeof body.displayName !== 'string'
        || !body.source || !body.protocol || typeof body.dataBoundary !== 'string' || typeof body.connectionRef !== 'string'
        || (body.note !== undefined && typeof body.note !== 'string')
      ) {
        send(response, 400, { error: 'Agent Adapter 候选必须提供 id、version、displayName、source、protocol、dataBoundary 与 connectionRef' });
        return;
      }
      try {
        send(response, 201, agentAdapterSummary(agentAdapters.registerCandidate({
          ...(body as unknown as Omit<RegisterAgentAdapterRequest, 'at'>), at: Date.now(),
        })));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Agent Adapter 候选无效' });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent-adapters/sessions') {
      const body = await jsonBody(request) as Record<string, unknown>;
      if (
        typeof body.adapterId !== 'string' || typeof body.adapterSessionId !== 'string' || typeof body.parentTaskId !== 'string'
        || typeof body.parentRunId !== 'string' || typeof body.agentSessionId !== 'string' || typeof body.transport !== 'string'
        || typeof body.protocolVersion !== 'string' || !Array.isArray(body.offeredCapabilities)
      ) {
        send(response, 400, { error: 'Adapter handshake 必须提供 adapterId、独立 adapterSessionId、父 task/run、外部 agentSessionId、transport、protocolVersion 与 offeredCapabilities' });
        return;
      }
      try {
        send(response, 201, agentAdapters.negotiate({
          ...(body as unknown as Omit<AgentAdapterHandshakeRequest, 'at'>), at: Date.now(),
        }));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Adapter handshake 无效' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/agent-adapters/sessions') {
      const taskId = url.searchParams.get('taskId');
      const runId = url.searchParams.get('runId');
      if (!taskId || !runId) {
        send(response, 400, { error: '查询 Adapter sessions 必须提供 taskId 与 runId' });
        return;
      }
      try {
        send(response, 200, agentAdapters.listSessions(taskId, runId));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Adapter sessions 查询无效' });
      }
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] === 'sessions' && segments[3] && segments[4] === 'bridge' && segments.length === 5) {
      const body = await jsonBody(request) as { mode?: unknown };
      if (body.mode !== 'read-only' && body.mode !== 'approval-required') {
        send(response, 400, { error: 'Adapter bridge mode 必须是 read-only 或 approval-required' });
        return;
      }
      try {
        send(response, 200, agentAdapters.openBridge({ adapterSessionId: segments[3], mode: body.mode, at: Date.now() }));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Adapter bridge 无效' });
      }
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] === 'sessions' && segments[3] && segments[4] === 'read-only-intents' && segments.length === 5) {
      const body = await jsonBody(request) as { intentId?: unknown; capability?: unknown; summary?: unknown };
      if (typeof body.intentId !== 'string' || typeof body.capability !== 'string' || typeof body.summary !== 'string') {
        send(response, 400, { error: '只读 Adapter intent 必须提供 intentId、capability 与 summary' });
        return;
      }
      try {
        send(response, 201, agentAdapters.proposeReadOnlyIntent({
          adapterSessionId: segments[3], intentId: body.intentId,
          capability: body.capability as 'document.parse' | 'model.chat' | 'filesystem.read', summary: body.summary, at: Date.now(),
        }));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : '只读 Adapter intent 无效' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/agent-adapters/mailbox') {
      const taskId = url.searchParams.get('taskId') ?? undefined;
      const runId = url.searchParams.get('runId') ?? undefined;
      try {
        send(response, 200, agentAdapters.listMailbox(taskId, runId));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Adapter mailbox 查询无效' });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent-adapters/mailbox') {
      const body = await jsonBody(request) as { mailboxId?: unknown; adapterSessionId?: unknown; intentId?: unknown; capability?: unknown; summary?: unknown };
      if (typeof body.mailboxId !== 'string' || typeof body.adapterSessionId !== 'string' || typeof body.intentId !== 'string' || typeof body.capability !== 'string' || typeof body.summary !== 'string') {
        send(response, 400, { error: 'Adapter mailbox 必须提供 mailboxId、adapterSessionId、intentId、capability 与 summary' });
        return;
      }
      try {
        send(response, 201, agentAdapters.proposeApproval({
          mailboxId: body.mailboxId, adapterSessionId: body.adapterSessionId, intentId: body.intentId,
          capability: body.capability as CapabilityPolicyRule['capability'], summary: body.summary, at: Date.now(),
        }));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Adapter mailbox 无效' });
      }
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] === 'mailbox' && segments[3] && segments[4] && segments.length === 5) {
      const operation = segments[4];
      if (operation !== 'approve' && operation !== 'deny' && operation !== 'expire') {
        send(response, 404, { error: 'Adapter mailbox 操作必须是 approve、deny 或 expire' });
        return;
      }
      const body = await jsonBody(request) as { reviewedBy?: unknown; note?: unknown };
      if ((operation !== 'expire' && typeof body.reviewedBy !== 'string') || (body.note !== undefined && typeof body.note !== 'string')) {
        send(response, 400, { error: operation === 'expire' ? 'Adapter mailbox expire 的 note 只能为字符串' : 'Adapter mailbox 决定必须提供 reviewedBy，note 只能为字符串' });
        return;
      }
      try {
        const item = operation === 'approve'
          ? agentAdapters.approveMailbox(segments[3], body.reviewedBy as string, Date.now(), body.note)
          : operation === 'deny'
            ? agentAdapters.denyMailbox(segments[3], body.reviewedBy as string, Date.now(), body.note)
            : agentAdapters.expireMailbox(segments[3], Date.now(), body.note);
        send(response, 200, item);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Adapter mailbox 操作无效' });
      }
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'agent-adapters' && segments[2] && segments[3] && segments.length === 4) {
      const operation = segments[3];
      if (operation !== 'review' && operation !== 'disable' && operation !== 'revoke') {
        send(response, 404, { error: 'Agent Adapter 操作必须是 review、disable 或 revoke' });
        return;
      }
      const body = await jsonBody(request) as { reviewedBy?: unknown; verifiedDigest?: unknown; note?: unknown };
      if (typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string') || (operation === 'review' && typeof body.verifiedDigest !== 'string')) {
        send(response, 400, { error: operation === 'review' ? 'Agent Adapter review 必须提供 reviewedBy 与 verifiedDigest' : 'Agent Adapter 状态变更必须提供 reviewedBy' });
        return;
      }
      try {
        const manifest = operation === 'review'
          ? agentAdapters.review(segments[2], body.verifiedDigest as string, body.reviewedBy, Date.now(), body.note)
          : operation === 'disable'
            ? agentAdapters.disable(segments[2], body.reviewedBy, Date.now(), body.note)
            : agentAdapters.revoke(segments[2], body.reviewedBy, Date.now(), body.note);
        send(response, 200, agentAdapterSummary(manifest));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Agent Adapter 状态变更无效' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/skills/packs') {
      send(response, 200, skillPacks.list().map(skillPackSummary));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/skills/packs') {
      const body = await jsonBody(request) as Record<string, unknown>;
      if (
        typeof body.id !== 'string' || typeof body.version !== 'string' || typeof body.displayName !== 'string'
        || !body.source || typeof body.content !== 'string'
        || (body.estimatedTokens !== undefined && (!Number.isSafeInteger(body.estimatedTokens) || typeof body.estimatedTokens !== 'number'))
        || (body.maxInjectionTokens !== undefined && (!Number.isSafeInteger(body.maxInjectionTokens) || typeof body.maxInjectionTokens !== 'number'))
        || (body.note !== undefined && typeof body.note !== 'string')
      ) {
        send(response, 400, { error: 'Skill Pack 候选必须提供 id、version、displayName、source 与纯文本 content；token 预算和 note 可选' });
        return;
      }
      try {
        send(response, 201, skillPackSummary(skillPacks.registerCandidate({
          ...(body as unknown as Omit<RegisterSkillPackCandidateRequest, 'at'>), at: Date.now(),
        })));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Skill Pack 候选无效' });
      }
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'skills' && segments[2] === 'packs' && segments[3] && segments[4] && segments.length === 5) {
      const operation = segments[4];
      if (operation !== 'review' && operation !== 'publish' && operation !== 'disable' && operation !== 'revoke') {
        send(response, 404, { error: 'Skill Pack 操作必须是 review、publish、disable 或 revoke' });
        return;
      }
      const body = await jsonBody(request) as { reviewedBy?: unknown; verifiedDigest?: unknown; note?: unknown };
      if (
        typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')
        || (operation === 'publish' && typeof body.verifiedDigest !== 'string')
      ) {
        send(response, 400, { error: operation === 'publish' ? 'Skill Pack 发布必须提供 reviewedBy 与 verifiedDigest' : 'Skill Pack 状态变更必须提供 reviewedBy' });
        return;
      }
      try {
        const at = Date.now();
        const manifest = operation === 'review'
          ? skillPacks.review(segments[3], body.reviewedBy, at, body.note)
          : operation === 'publish'
            ? skillPacks.publish(segments[3], body.verifiedDigest as string, body.reviewedBy, at, body.note)
            : operation === 'disable'
              ? skillPacks.disable(segments[3], body.reviewedBy, at, body.note)
              : skillPacks.revoke(segments[3], body.reviewedBy, at, body.note);
        send(response, 200, skillPackSummary(manifest));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Skill Pack 状态变更无效' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/providers/profiles') {
      send(response, 200, providerProfiles.list());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/providers/profiles') {
      const body = await jsonBody(request) as Record<string, unknown>;
      if (
        typeof body.id !== 'string' || typeof body.displayName !== 'string' || !Array.isArray(body.driverIds)
        || typeof body.maximumDataBoundary !== 'string' || typeof body.reviewedBy !== 'string'
        || (body.credentialReference !== undefined && typeof body.credentialReference !== 'string')
        || (body.note !== undefined && typeof body.note !== 'string')
      ) {
        send(response, 400, { error: 'Provider Profile 必须提供 id、displayName、driverIds、maximumDataBoundary 与 reviewedBy；仅可选 credentialReference 标识' });
        return;
      }
      try {
        send(response, 201, providerProfiles.register({
          ...(body as unknown as Omit<RegisterProviderProfileRequest, 'at'>), at: Date.now(),
        }));
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Provider Profile 无效' });
      }
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'providers' && segments[2] === 'profiles' && segments[3] && segments[4] && segments.length === 5) {
      const operation = segments[4];
      if (operation !== 'update' && operation !== 'activate' && operation !== 'disable' && operation !== 'revoke' && operation !== 'rollback') {
        send(response, 404, { error: 'Provider Profile 操作必须是 update、activate、disable、revoke 或 rollback' });
        return;
      }
      const body = await jsonBody(request) as Record<string, unknown>;
      if (typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) {
        send(response, 400, { error: 'Provider Profile 变更必须提供 reviewedBy，note 只能为字符串' });
        return;
      }
      if (operation === 'rollback' && (!Number.isSafeInteger(body.revision) || typeof body.revision !== 'number')) {
        send(response, 400, { error: 'Provider Profile rollback 必须提供正整数 revision' });
        return;
      }
      try {
        const at = Date.now();
        const profile = operation === 'update'
          ? providerProfiles.update(segments[3], { ...(body as unknown as Omit<UpdateProviderProfileRequest, 'at'>), at })
          : operation === 'activate'
            ? providerProfiles.activate(segments[3], body.reviewedBy, at, body.note as string | undefined)
            : operation === 'disable'
              ? providerProfiles.disable(segments[3], body.reviewedBy, at, body.note as string | undefined)
              : operation === 'revoke'
                ? providerProfiles.revoke(segments[3], body.reviewedBy, at, body.note as string | undefined)
                : providerProfiles.rollback(segments[3], body.revision as number, body.reviewedBy, at, body.note as string | undefined);
        send(response, 200, profile);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'Provider Profile 变更无效' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/extensions/doctor') {
      send(response, 200, extensionDoctor.inspect());
      return;
    }

    if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'extensions' && segments[2] === 'plans' && segments[3] && segments[4] && segments.length === 5) {
      send(response, 200, extensionPlanStore.list(segments[3], segments[4]));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/extensions/plans') {
      const body = await jsonBody(request) as { taskId?: unknown; runId?: unknown; target?: unknown; planId?: unknown };
      if (typeof body.taskId !== 'string' || typeof body.runId !== 'string' || !body.target || typeof body.target !== 'object' || (body.planId !== undefined && typeof body.planId !== 'string')) {
        send(response, 400, { error: 'extension plan 必须提供 taskId、runId、target，planId 只能为字符串' });
        return;
      }
      try {
        const plan = extensionActivationPlanner.plan({
          taskId: body.taskId,
          runId: body.runId,
          target: body.target as ExtensionActivationTarget,
          planId: body.planId as string | undefined,
          at: Date.now(),
        });
        send(response, 201, plan);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'extension plan 无效' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/extensions') {
      send(response, 200, extensionRegistry.list());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/extensions') {
      const body = await jsonBody(request) as Record<string, unknown>;
      if (
        typeof body.id !== 'string' || typeof body.version !== 'string' || typeof body.kind !== 'string'
        || typeof body.displayName !== 'string' || !body.source || !body.compatibility
        || !Array.isArray(body.declaredCapabilities) || !Array.isArray(body.requestedPermissions)
        || typeof body.dataBoundary !== 'string' || !body.resourceBudget
        || (body.note !== undefined && typeof body.note !== 'string')
      ) {
        send(response, 400, { error: 'extension 必须提供 id、version、kind、displayName、source、compatibility、capabilities、dataBoundary 与 resourceBudget' });
        return;
      }
      try {
        const discovered = extensionRegistry.discover({
          ...(body as unknown as Omit<DiscoverExtensionRequest, 'at'>),
          at: Date.now(),
        });
        send(response, 201, discovered);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'extension manifest 无效' });
      }
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'extensions' && segments[2] && segments[3] && segments.length === 4) {
      const operation = segments[3];
      if (operation !== 'review' && operation !== 'install' && operation !== 'disable' && operation !== 'revoke') {
        send(response, 404, { error: 'extension 状态操作必须是 review、install、disable 或 revoke' });
        return;
      }
      const body = await jsonBody(request) as { reviewedBy?: unknown; verifiedDigest?: unknown; note?: unknown };
      if (
        typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')
        || (operation === 'install' && typeof body.verifiedDigest !== 'string')
      ) {
        send(response, 400, { error: operation === 'install' ? 'extension 安装必须提供 reviewedBy 与 verifiedDigest' : 'extension 状态变更必须提供 reviewedBy' });
        return;
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
        send(response, 200, manifest);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : 'extension 状态变更无效' });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/mcp/servers') {
      send(response, 200, mcpRegistry.list());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/servers') {
      const body = await jsonBody(request) as {
        id?: unknown; displayName?: unknown; connection?: unknown; declaredTools?: unknown;
        sourceDigest?: unknown; reviewedBy?: unknown; note?: unknown;
      };
      if (
        typeof body.id !== 'string' || typeof body.displayName !== 'string' || !body.connection
        || !Array.isArray(body.declaredTools) || typeof body.sourceDigest !== 'string' || typeof body.reviewedBy !== 'string'
        || (body.note !== undefined && typeof body.note !== 'string')
      ) {
        send(response, 400, { error: 'MCP manifest 必须提供 id、displayName、connection、declaredTools、sourceDigest 与 reviewedBy' });
        return;
      }
      send(response, 201, mcpRegistry.register({
        id: body.id, displayName: body.displayName, connection: body.connection as McpConnection,
        declaredTools: body.declaredTools as McpToolManifest[], sourceDigest: body.sourceDigest,
        reviewedBy: body.reviewedBy, note: body.note as string | undefined, at: Date.now(),
      }));
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'mcp' && segments[2] === 'servers' && segments[3] && segments[4] && segments.length === 5) {
      const operation = segments[4];
      if (operation !== 'enable' && operation !== 'disable' && operation !== 'revoke') {
        send(response, 404, { error: 'MCP 状态操作必须是 enable、disable 或 revoke' });
        return;
      }
      const body = await jsonBody(request) as { reviewedBy?: unknown; note?: unknown };
      if (typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) {
        send(response, 400, { error: 'MCP 状态变更必须提供 reviewedBy，note 只能为字符串' });
        return;
      }
      const at = Date.now();
      const manifest = operation === 'enable'
        ? mcpRegistry.enable(segments[3], body.reviewedBy, at, body.note)
        : operation === 'disable'
          ? mcpRegistry.disable(segments[3], body.reviewedBy, at, body.note)
          : mcpRegistry.revoke(segments[3], body.reviewedBy, at, body.note);
      send(response, 200, manifest);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/knowledge/workspaces') {
      send(response, 200, knowledgeWorkspaces.list());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/knowledge/workspaces') {
      const body = await jsonBody(request) as { id?: unknown; title?: unknown; description?: unknown };
      if (typeof body.id !== 'string' || typeof body.title !== 'string' || (body.description !== undefined && typeof body.description !== 'string')) {
        send(response, 400, { error: '知识工作区必须具有有效 id、title，description 只能为字符串' });
        return;
      }
      send(response, 201, knowledgeWorkspaces.create({
        id: body.id, title: body.title, description: body.description, at: Date.now(),
      }));
      return;
    }

    if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'knowledge' && segments[2] === 'workspaces' && segments[3] && segments[4] === 'documents' && segments.length === 5) {
      const body = await jsonBody(request) as {
        id?: unknown; title?: unknown; sourceUri?: unknown; text?: unknown; updatedAt?: unknown; persistence?: unknown;
      };
      if (
        typeof body.id !== 'string' || typeof body.title !== 'string' || typeof body.sourceUri !== 'string'
        || typeof body.text !== 'string' || !body.id.trim() || !body.title.trim() || !body.sourceUri.trim() || !body.text.trim()
      ) {
        send(response, 400, { error: '知识文档必须具有非空 id、title、sourceUri 与 text' });
        return;
      }
      const persistence = body.persistence === undefined ? 'durable' : body.persistence;
      if (!isSessionPersistence(persistence)) {
        send(response, 400, { error: 'persistence 必须是 durable、ephemeral 或 incognito' });
        return;
      }
      if (persistence === 'incognito') {
        send(response, 403, { error: 'incognito 会话不得摄取、索引或读取持久知识工作区' });
        return;
      }
      const chunks = knowledgeWorkspaces.ingest({
        workspaceId: segments[3], persistence,
        document: {
          id: body.id.trim(), title: body.title.trim(), sourceUri: body.sourceUri.trim(), text: body.text.trim(),
          updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now(),
        },
      });
      send(response, 201, { workspaceId: segments[3], documentId: body.id.trim(), chunks: chunks.length });
      return;
    }

    if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'knowledge' && segments[2] === 'workspaces' && segments[3] && segments[4] === 'retrieve' && segments.length === 5) {
      const persistence = url.searchParams.get('persistence') ?? 'durable';
      if (!isSessionPersistence(persistence)) {
        send(response, 400, { error: 'persistence 必须是 durable、ephemeral 或 incognito' });
        return;
      }
      if (persistence === 'incognito') {
        send(response, 403, { error: 'incognito 会话不得摄取、索引或读取持久知识工作区' });
        return;
      }
      const mode = url.searchParams.get('mode') ?? 'focused';
      const requestedMaxTokens = Number(url.searchParams.get('maxTokens') ?? 4_000);
      if (!Number.isInteger(requestedMaxTokens) || requestedMaxTokens < 0 || requestedMaxTokens > 32_768) {
        send(response, 400, { error: 'maxTokens 必须是 0-32768 的整数' });
        return;
      }
      if (mode === 'full_context') {
        const documentId = url.searchParams.get('documentId');
        if (!documentId) {
          send(response, 400, { error: 'full_context 检索必须提供 documentId' });
          return;
        }
        send(response, 200, knowledgeWorkspaces.retrieve({
          workspaceId: segments[3], persistence, mode, documentId, at: Date.now(), maxTokens: requestedMaxTokens,
        }));
        return;
      }
      if (mode !== 'focused') {
        send(response, 400, { error: 'mode 必须是 focused 或 full_context' });
        return;
      }
      const query = url.searchParams.get('q') ?? '';
      const requestedLimit = Number(url.searchParams.get('limit') ?? 5);
      const maxResults = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 20 ? requestedLimit : 5;
      send(response, 200, knowledgeWorkspaces.retrieve({
        workspaceId: segments[3], persistence, mode, query, at: Date.now(), maxResults, maxTokens: requestedMaxTokens,
      }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/knowledge/documents') {
      const body = await jsonBody(request) as {
        id?: unknown; title?: unknown; sourceUri?: unknown; text?: unknown; updatedAt?: unknown;
      };
      if (
        typeof body.id !== 'string' || typeof body.title !== 'string' || typeof body.sourceUri !== 'string'
        || typeof body.text !== 'string' || !body.id.trim() || !body.title.trim() || !body.sourceUri.trim() || !body.text.trim()
      ) {
        send(response, 400, { error: '知识文档必须具有非空 id、title、sourceUri 与 text' });
        return;
      }
      const chunks = knowledgeWorkspaces.ingest({
        workspaceId: DEFAULT_KNOWLEDGE_WORKSPACE_ID, persistence: 'durable',
        document: {
          id: body.id.trim(), title: body.title.trim(), sourceUri: body.sourceUri.trim(), text: body.text.trim(),
          updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : Date.now(),
        },
      });
      send(response, 201, { documentId: body.id.trim(), chunks: chunks.length });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/knowledge/search') {
      const query = url.searchParams.get('q') ?? '';
      if (!query.trim()) {
        send(response, 200, []);
        return;
      }
      const requestedLimit = Number(url.searchParams.get('limit') ?? 5);
      const maxResults = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 20 ? requestedLimit : 5;
      const retrieval = knowledgeWorkspaces.retrieve({
        workspaceId: DEFAULT_KNOWLEDGE_WORKSPACE_ID, persistence: 'durable', mode: 'focused',
        query, at: Date.now(), maxResults, maxTokens: 4_000,
      });
      send(response, 200, retrieval.results.map((result) => ({ ...result.citation, score: result.score })));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await jsonBody(request) as { goal?: unknown; profileId?: unknown };
      const key = idempotencyKey(request);
      if (typeof body.goal !== 'string' || !body.goal.trim() || !isProfileId(body.profileId)) {
        send(response, 400, { error: 'goal 和 profileId 必须有效' });
        return;
      }
      if (!key) {
        send(response, 400, { error: '任务提交必须提供 Idempotency-Key' });
        return;
      }
      const goal = body.goal.trim();
      const fingerprint = commandFingerprint('submit', { goal, profileId: body.profileId });
      const existing = commandReceipts.get('submit', key);
      const claimed = commandReceipts.claim(existing ?? {
        schemaVersion: 1,
        command: 'submit',
        idempotencyKey: key,
        fingerprint,
        taskId: `task-${randomUUID()}`,
        runId: `run-${randomUUID()}`,
        goal,
        profileId: body.profileId,
        acceptedAt: Date.now(),
      });
      if (claimed.receipt.fingerprint !== fingerprint) {
        send(response, 409, { error: 'Idempotency-Key 已绑定到不同任务意图' });
        return;
      }
      if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
        send(response, 200, claimed.receipt.snapshot);
        return;
      }
      const runtimeRequest = createRequest(claimed.receipt.goal, claimed.receipt.profileId, {
        taskId: claimed.receipt.taskId, runId: claimed.receipt.runId,
      });
      requests.set(runKey(runtimeRequest.taskId, runtimeRequest.runId), runtimeRequest);
      const snapshot = await runtime.submit(runtimeRequest);
      commandReceipts.complete('submit', key, snapshot, Date.now());
      send(response, claimed.kind === 'claimed' ? 201 : 200, snapshot);
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'tasks' && segments.length >= 4) {
      const [, , taskId, runId, operation, nodeId] = segments;
      const key = runKey(taskId, runId);
      const runtimeRequest = requests.get(key);
      if (request.method === 'GET' && !operation) {
        const snapshot = runtime.snapshot(taskId, runId);
        if (!snapshot) send(response, 404, { error: '任务快照不存在' });
        else {
          const knownAttempt = Number(url.searchParams.get('sinceAttempt'));
          if (Number.isInteger(knownAttempt) && knownAttempt === snapshot.attempt) send(response, 204);
          else send(response, 200, snapshot);
        }
        return;
      }
      if (request.method === 'GET' && operation === 'events') {
        const events = eventsByRun.get(key);
        if (!events) send(response, 404, { error: '当前本地网关没有此任务的事件流' });
        else send(response, 200, events);
        return;
      }
      if (request.method === 'POST' && operation === 'subtasks' && segments.length === 5) {
        const parentSnapshot = runtime.snapshot(taskId, runId);
        if (!parentSnapshot) {
          send(response, 404, { error: '父任务快照不存在，不能创建子任务' });
          return;
        }
        const body = await jsonBody(request) as {
          subtaskId?: unknown; role?: unknown; goal?: unknown;
          budget?: { maxInputTokens?: unknown; maxOutputTokens?: unknown; maxToolCalls?: unknown };
        };
        if (
          typeof body.subtaskId !== 'string' || !isReadOnlySubtaskRole(body.role) || typeof body.goal !== 'string'
          || !body.budget || typeof body.budget.maxInputTokens !== 'number'
          || typeof body.budget.maxOutputTokens !== 'number' || typeof body.budget.maxToolCalls !== 'number'
        ) {
          send(response, 400, { error: '子任务必须具有 subtaskId、explore/scout role、goal 与完整预算' });
          return;
        }
        readOnlySubtasks.spawn({
          subtaskId: body.subtaskId, parentTaskId: taskId, parentRunId: runId, role: body.role,
          goal: body.goal,
          budget: {
            maxInputTokens: body.budget.maxInputTokens,
            maxOutputTokens: body.budget.maxOutputTokens,
            maxToolCalls: body.budget.maxToolCalls,
          },
          at: Date.now(),
        });
        const snapshot = await readOnlySubtasks.run(body.subtaskId, {
          async run(context) {
            return {
              summary: `${context.role} 只读子任务已完成父任务状态检查；未执行写入、网络、Shell 或浏览器操作。`,
              estimatedOutputTokens: 24,
              citations: [{
                kind: 'task_output', sourceId: taskId, sourceUri: `local://task/${taskId}/${runId}`,
                excerpt: `父任务当前状态：${parentSnapshot.status}。`,
              }],
            };
          },
        }, Date.now());
        send(response, 201, snapshot);
        return;
      }
      if (request.method === 'GET' && operation === 'subtasks' && nodeId && segments.length === 6) {
        const snapshot = readOnlySubtasks.snapshot(nodeId);
        if (!snapshot || snapshot.parentTaskId !== taskId || snapshot.parentRunId !== runId) {
          send(response, 404, { error: '只读子任务不存在或不属于指定父任务' });
        } else send(response, 200, snapshot);
        return;
      }
      if (request.method === 'GET' && operation === 'subtasks' && nodeId && segments[6] === 'summary' && segments.length === 7) {
        const snapshot = readOnlySubtasks.snapshot(nodeId);
        if (!snapshot || snapshot.parentTaskId !== taskId || snapshot.parentRunId !== runId) {
          send(response, 404, { error: '只读子任务不存在或不属于指定父任务' });
          return;
        }
        send(response, 200, readOnlySubtasks.summaryReference(nodeId));
        return;
      }
      if (!runtimeRequest) {
        send(response, 404, { error: '当前本地网关没有此任务的可恢复请求；请在同一网关会话中提交任务' });
        return;
      }
      if (request.method === 'POST' && operation === 'resume') {
        const commandKey = idempotencyKey(request);
        if (!commandKey) {
          send(response, 400, { error: '任务恢复必须提供 Idempotency-Key' });
          return;
        }
        const fingerprint = commandFingerprint('resume', { taskId, runId });
        const claimed = commandReceipts.claim({
          schemaVersion: 1, command: 'resume', idempotencyKey: commandKey, fingerprint,
          taskId, runId, goal: runtimeRequest.goal, profileId: runtimeRequest.profileId, acceptedAt: Date.now(),
        });
        if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
          send(response, 200, claimed.receipt.snapshot);
          return;
        }
        const snapshot = await runtime.resume(runtimeRequest);
        commandReceipts.complete('resume', commandKey, snapshot, Date.now());
        send(response, 200, snapshot);
        return;
      }
      if (request.method === 'POST' && operation === 'approvals' && nodeId) {
        if (!runtimeRequest.nodes.some((node) => node.id === nodeId)) {
          send(response, 404, { error: '审批节点不存在' });
          return;
        }
        const commandKey = idempotencyKey(request);
        if (!commandKey) {
          send(response, 400, { error: '任务审批必须提供 Idempotency-Key' });
          return;
        }
        const fingerprint = commandFingerprint('approve', { taskId, runId, nodeId });
        const claimed = commandReceipts.claim({
          schemaVersion: 1, command: 'approve', idempotencyKey: commandKey, fingerprint,
          taskId, runId, nodeId, goal: runtimeRequest.goal, profileId: runtimeRequest.profileId, acceptedAt: Date.now(),
        });
        if (claimed.kind === 'replayed' && claimed.receipt.snapshot) {
          send(response, 200, claimed.receipt.snapshot);
          return;
        }
        approvedActions.add(`${runId}:${nodeId}`);
        eventsByRun.get(key)?.push(event('approval.resolved', taskId, runId, {
          actionId: `${runId}:${nodeId}`,
          decision: 'approved',
          resolvedBy: 'local-user',
        }));
        const snapshot = await runtime.resume(runtimeRequest);
        commandReceipts.complete('approve', commandKey, snapshot, Date.now());
        send(response, 200, snapshot);
        return;
      }
    }
    send(response, 404, { error: '未找到任务运行时路由' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown local runtime error';
    send(response, message.includes('64KiB') || message.includes('JSON') ? 400 : 500, { error: message });
  }
}

const server = createServer((request, response) => { void handle(request, response); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Work OS runtime gateway listening on http://127.0.0.1:${PORT}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    knowledgeStoreFactory.close();
    knowledgeWorkspaceStore.close();
    commandReceipts.close();
    subtaskStore.close();
    mcpManifestStore.close();
    extensionManifestStore.close();
    extensionPlanStore.close();
    providerProfileStore.close();
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
