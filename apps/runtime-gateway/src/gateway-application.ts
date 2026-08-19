import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { AgentProfileId, CapabilityPolicyRule, TaskEvent } from '@awo/protocol';
import {
  AgentAdapterControlPlane,
  AuditedScheduleControlPlane,
  ExtensionActivationPlanner,
  ExtensionDoctor,
  ExtensionRegistry,
  InMemoryApprovalPort,
  LocalTaskRuntimeService,
  McpRegistry,
  ReadOnlySubtaskService,
  RuleBasedCapabilityPolicy,
  SqliteAdapterApprovalMailboxStore,
  SqliteAgentAdapterManifestStore,
  SqliteAgentAdapterSessionStore,
  SqliteExtensionManifestStore,
  SqliteExtensionPlanStore,
  SqliteMcpManifestStore,
  SqliteScheduleManifestStore,
  SqliteScheduledRunStore,
  SqliteSubtaskSnapshotStore,
  SqliteTaskCommandReceiptStore,
  SqliteTaskSnapshotStore,
  type DAGNode,
  type TaskRuntimeRequest,
} from '@awo/agent-runtime';
import {
  KnowledgeWorkspaceService,
  SkillPackRegistry,
  SqliteKnowledgeWorkspaceStore,
  SqliteSkillPackStore,
  SqliteWorkspaceKnowledgeStoreFactory,
} from '@awo/knowledge-workflow';
import { ProviderProfileRegistry, SqliteProviderProfileStore } from '@awo/provider-sdk';
import type { GatewayDependencies } from './http/gateway-dependencies.js';
import { handleGatewayRequest } from './http/router.js';

const PORT = Number(process.env.AWO_RUNTIME_PORT ?? 4318);
const DEFAULT_KNOWLEDGE_WORKSPACE_ID = 'default-local';

const BASELINE_RULES: readonly CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: '本地任务模板允许文档解析' },
  { capability: 'model.chat', decision: 'allow', reason: '本地任务模板允许受控模型推理' },
  { capability: 'filesystem.read', decision: 'allow', reason: '本地任务模板允许只读检查' },
  { capability: 'filesystem.write', decision: 'require_approval', reason: '写入意图必须经本地审批' },
  { capability: 'network.fetch', decision: 'require_approval', reason: '网络访问必须经本地审批' },
  { capability: 'shell.execute', decision: 'require_approval', reason: 'Shell 执行必须经本地审批' },
  { capability: 'browser.control', decision: 'require_approval', reason: '浏览器控制必须经本地审批' },
];

function runKey(taskId: string, runId: string): string {
  return `${taskId}:${runId}`;
}

function createTaskNodes(profileId: AgentProfileId): readonly DAGNode[] {
  const readOnly = [
    {
      id: 'understand', kind: 'model' as const,
      tool: { name: 'local.task.understand', args: {}, capability: 'model.chat' as const, risk: 'low' as const },
      idempotencyKey: 'understand:v1', deps: [],
    },
    {
      id: 'inspect', kind: 'tool' as const,
      tool: { name: 'workspace.inspect', args: {}, capability: 'filesystem.read' as const, risk: 'low' as const },
      idempotencyKey: 'inspect:v1', deps: ['understand'],
    },
  ];
  if (profileId !== 'build') return readOnly;
  return [
    ...readOnly,
    {
      id: 'deliver', kind: 'tool' as const,
      tool: { name: 'workspace.write.intent', args: {}, capability: 'filesystem.write' as const, risk: 'medium' as const },
      idempotencyKey: 'deliver:v1', deps: ['inspect'],
    },
  ];
}

export interface GatewayComposition {
  readonly dependencies: GatewayDependencies;
  close(): void;
}

/**
 * 唯一 composition root：读取本地配置、创建具体 SQLite adapter、把它们注入领域控制面。
 * 模块导入本身不会打开数据库或注册默认工作区；只有明确调用本工厂才会分配资源。
 */
export function createGatewayComposition(): GatewayComposition {
  const snapshotPath = resolve(process.env.AWO_SNAPSHOT_DB ?? '.awo/task-snapshots.sqlite');
  const knowledgeWorkspacePath = resolve(process.env.AWO_KNOWLEDGE_WORKSPACE_DB ?? '.awo/knowledge-workspaces.sqlite');
  const knowledgeWorkspaceDir = resolve(process.env.AWO_KNOWLEDGE_WORKSPACE_DIR ?? '.awo/knowledge-workspaces');
  const receiptPath = resolve(process.env.AWO_RECEIPT_DB ?? '.awo/task-command-receipts.sqlite');
  const subtaskPath = resolve(process.env.AWO_SUBTASK_DB ?? '.awo/read-only-subtasks.sqlite');
  const mcpManifestPath = resolve(process.env.AWO_MCP_MANIFEST_DB ?? '.awo/mcp-manifests.sqlite');
  const extensionManifestPath = resolve(process.env.AWO_EXTENSION_MANIFEST_DB ?? '.awo/extension-manifests.sqlite');
  const extensionPlanPath = resolve(process.env.AWO_EXTENSION_PLAN_DB ?? '.awo/extension-plans.sqlite');
  const providerProfilePath = resolve(process.env.AWO_PROVIDER_PROFILE_DB ?? '.awo/provider-profiles.sqlite');
  const skillPackPath = resolve(process.env.AWO_SKILL_PACK_DB ?? '.awo/skill-packs.sqlite');
  const agentAdapterManifestPath = resolve(process.env.AWO_AGENT_ADAPTER_MANIFEST_DB ?? '.awo/agent-adapters.sqlite');
  const agentAdapterSessionPath = resolve(process.env.AWO_AGENT_ADAPTER_SESSION_DB ?? '.awo/agent-adapter-sessions.sqlite');
  const agentAdapterMailboxPath = resolve(process.env.AWO_AGENT_ADAPTER_MAILBOX_DB ?? '.awo/agent-adapter-mailbox.sqlite');
  const scheduleManifestPath = resolve(process.env.AWO_SCHEDULE_MANIFEST_DB ?? '.awo/audited-schedules.sqlite');
  const scheduleRunPath = resolve(process.env.AWO_SCHEDULE_RUN_DB ?? '.awo/audited-schedule-runs.sqlite');

  const store = new SqliteTaskSnapshotStore(snapshotPath);
  const knowledgeWorkspaceStore = new SqliteKnowledgeWorkspaceStore(knowledgeWorkspacePath);
  const knowledgeStoreFactory = new SqliteWorkspaceKnowledgeStoreFactory(knowledgeWorkspaceDir);
  const knowledgeWorkspaces = new KnowledgeWorkspaceService(knowledgeWorkspaceStore, knowledgeStoreFactory);
  const commandReceipts = new SqliteTaskCommandReceiptStore(receiptPath);
  const subtaskStore = new SqliteSubtaskSnapshotStore(subtaskPath);
  const readOnlySubtasks = new ReadOnlySubtaskService(subtaskStore);
  const mcpManifestStore = new SqliteMcpManifestStore(mcpManifestPath);
  const mcpRegistry = new McpRegistry(mcpManifestStore);
  const extensionManifestStore = new SqliteExtensionManifestStore(extensionManifestPath);
  const extensionRegistry = new ExtensionRegistry(extensionManifestStore);
  const extensionPlanStore = new SqliteExtensionPlanStore(extensionPlanPath);
  const providerProfileStore = new SqliteProviderProfileStore(providerProfilePath);
  const providerProfiles = new ProviderProfileRegistry(providerProfileStore);
  const skillPackStore = new SqliteSkillPackStore(skillPackPath);
  const skillPacks = new SkillPackRegistry(skillPackStore);
  const agentAdapterManifestStore = new SqliteAgentAdapterManifestStore(agentAdapterManifestPath);
  const agentAdapterSessionStore = new SqliteAgentAdapterSessionStore(agentAdapterSessionPath);
  const agentAdapterMailboxStore = new SqliteAdapterApprovalMailboxStore(agentAdapterMailboxPath);
  const agentAdapters = new AgentAdapterControlPlane(agentAdapterManifestStore, agentAdapterSessionStore, agentAdapterMailboxStore);
  const scheduleManifestStore = new SqliteScheduleManifestStore(scheduleManifestPath);
  const scheduledRunStore = new SqliteScheduledRunStore(scheduleRunPath);
  const schedules = new AuditedScheduleControlPlane(scheduleManifestStore, scheduledRunStore);

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
  const extensionActivationPlanner = new ExtensionActivationPlanner(extensionRegistry, new RuleBasedCapabilityPolicy(BASELINE_RULES), extensionPlanStore);
  const extensionDoctor = new ExtensionDoctor(extensionRegistry);

  function createEvent(type: TaskEvent['type'], taskId: string, runId: string, payload: Record<string, unknown>): TaskEvent {
    return { protocolVersion: '1.0', eventId: `gateway:${runId}:${type}:${randomUUID()}`, taskId, runId, at: Date.now(), type, ...payload } as TaskEvent;
  }

  function createTaskRequest(goal: string, profileId: AgentProfileId, identity: { taskId: string; runId: string }): TaskRuntimeRequest {
    const { taskId, runId } = identity;
    const events: TaskEvent[] = eventsByRun.get(runKey(taskId, runId)) ?? [
      createEvent('task.created', taskId, runId, { goal }),
      createEvent('agent.profile.selected', taskId, runId, { profileId }),
      createEvent('plan.proposed', taskId, runId, { steps: createTaskNodes(profileId).map((node) => ({ id: node.id, description: node.tool.name, risk: node.tool.risk })) }),
    ];
    const request: TaskRuntimeRequest = {
      taskId, runId, goal, profileId, nodes: createTaskNodes(profileId),
      baselinePolicy: new RuleBasedCapabilityPolicy(BASELINE_RULES),
      approvals: new InMemoryApprovalPort(approvedActions),
      runner: { async run(node) { return { ok: true, outputRef: `local://task/${taskId}/${node.id}` }; } },
      emit(nextEvent) { events.push(nextEvent); },
    };
    eventsByRun.set(runKey(taskId, runId), events);
    return request;
  }

  return {
    dependencies: {
      runtime, commandReceipts, readOnlySubtasks, mcpRegistry, extensionRegistry, extensionPlanStore,
      extensionActivationPlanner, extensionDoctor, providerProfiles, knowledgeWorkspaces, skillPacks,
      agentAdapters, schedules, defaultKnowledgeWorkspaceId: DEFAULT_KNOWLEDGE_WORKSPACE_ID,
      requests, eventsByRun, approvedActions, createTaskRequest, createEvent,
    },
    close(): void {
      store.close();
      knowledgeStoreFactory.close();
      knowledgeWorkspaceStore.close();
      commandReceipts.close();
      subtaskStore.close();
      mcpManifestStore.close();
      extensionManifestStore.close();
      extensionPlanStore.close();
      providerProfileStore.close();
    },
  };
}

export interface LocalGatewayApplication {
  close(): void;
}

/** 进程无关的 HTTP host：组合根只在启动时创建，信号处理仍由 main.ts 单独负责。 */
export function startLocalGateway(port = PORT): LocalGatewayApplication {
  const composition = createGatewayComposition();
  const server = createServer((request, response) => { void handleGatewayRequest(request, response, composition.dependencies); });
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI Work OS runtime gateway listening on http://127.0.0.1:${port}`);
  });
  return {
    close(): void {
      server.close(() => composition.close());
    },
  };
}
