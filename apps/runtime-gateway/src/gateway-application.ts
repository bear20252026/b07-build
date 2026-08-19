import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { AgentProfileId, CapabilityPolicyRule, TaskEvent } from '@awo/protocol';
import {
  AdministratorAuthorityLedger,
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
  RunTrajectoryLedger,
  SqliteAdapterApprovalMailboxStore,
  SqliteAdministratorLeaseStore,
  SqliteAgentAdapterManifestStore,
  SqliteAgentAdapterSessionStore,
  SqliteExtensionManifestStore,
  SqliteExtensionPlanStore,
  SqliteMcpManifestStore,
  SqliteScheduleManifestStore,
  SqliteScheduledRunStore,
  SqliteSubtaskSnapshotStore,
  SqliteRunTrajectoryStore,
  SqliteTaskCommandReceiptStore,
  SqliteTaskSnapshotStore,
  SqliteTrustedDesktopIssuerStore,
  TrustedDesktopIssuerRegistry,
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
import { LocalModelHealthRegistry, ProviderProfileRegistry, SqliteProviderProfileStore } from '@awo/provider-sdk';
import type { GatewayDependencies } from './http/gateway-dependencies.js';
import { createControlPlaneDiagnosticReport } from './control-plane-diagnostics.js';
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
  const runTrajectoryPath = resolve(process.env.AWO_RUN_TRAJECTORY_DB ?? '.awo/run-trajectories.sqlite');
  const administratorLeasePath = resolve(process.env.AWO_ADMINISTRATOR_LEASE_DB ?? '.awo/administrator-leases.sqlite');
  const trustedDesktopIssuerPath = resolve(process.env.AWO_TRUSTED_DESKTOP_ISSUER_DB ?? '.awo/trusted-desktop-issuers.sqlite');

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
  const localModelHealth = new LocalModelHealthRegistry();
  const skillPackStore = new SqliteSkillPackStore(skillPackPath);
  const skillPacks = new SkillPackRegistry(skillPackStore);
  const agentAdapterManifestStore = new SqliteAgentAdapterManifestStore(agentAdapterManifestPath);
  const agentAdapterSessionStore = new SqliteAgentAdapterSessionStore(agentAdapterSessionPath);
  const agentAdapterMailboxStore = new SqliteAdapterApprovalMailboxStore(agentAdapterMailboxPath);
  const agentAdapters = new AgentAdapterControlPlane(agentAdapterManifestStore, agentAdapterSessionStore, agentAdapterMailboxStore);
  const scheduleManifestStore = new SqliteScheduleManifestStore(scheduleManifestPath);
  const scheduledRunStore = new SqliteScheduledRunStore(scheduleRunPath);
  const schedules = new AuditedScheduleControlPlane(scheduleManifestStore, scheduledRunStore);
  const runTrajectoryStore = new SqliteRunTrajectoryStore(runTrajectoryPath);
  const runTrajectory = new RunTrajectoryLedger(runTrajectoryStore);
  const administratorLeaseStore = new SqliteAdministratorLeaseStore(administratorLeasePath);
  const administratorLeases = new AdministratorAuthorityLedger(administratorLeaseStore);
  const trustedDesktopIssuerStore = new SqliteTrustedDesktopIssuerStore(trustedDesktopIssuerPath);
  const trustedDesktopIssuers = new TrustedDesktopIssuerRegistry(trustedDesktopIssuerStore);

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

  function createTaskRequest(goal: string, profileId: AgentProfileId, authorityMode: import('@awo/protocol').ExecutionAuthorityMode, identity: { taskId: string; runId: string }): TaskRuntimeRequest {
    const { taskId, runId } = identity;
    const existingEvents = eventsByRun.get(runKey(taskId, runId));
    const events: TaskEvent[] = existingEvents ?? [
      createEvent('task.created', taskId, runId, { goal }),
      createEvent('agent.profile.selected', taskId, runId, { profileId }),
      createEvent('execution.authority.selected', taskId, runId, { authorityMode }),
      createEvent('plan.proposed', taskId, runId, { steps: createTaskNodes(profileId).map((node) => ({ id: node.id, description: node.tool.name, risk: node.tool.risk })) }),
    ];
    if (!existingEvents) {
      for (const event of events) runTrajectory.recordTaskEvent(event, 'gateway.intent');
    }
    const request: TaskRuntimeRequest = {
      taskId, runId, goal, profileId, authorityMode, administratorLeases, nodes: createTaskNodes(profileId),
      baselinePolicy: new RuleBasedCapabilityPolicy(BASELINE_RULES),
      approvals: new InMemoryApprovalPort(approvedActions),
      runner: { async run(node) { return { ok: true, outputRef: `local://task/${taskId}/${node.id}` }; } },
      emit(nextEvent) {
        events.push(nextEvent);
        runTrajectory.recordTaskEvent(nextEvent, 'task-runtime');
      },
    };
    eventsByRun.set(runKey(taskId, runId), events);
    return request;
  }

  let closed = false;
  const closeResources = (): void => {
    if (closed) return;
    closed = true;
    const closers: readonly (() => void)[] = [
      () => store.close(),
      () => knowledgeStoreFactory.close(),
      () => knowledgeWorkspaceStore.close(),
      () => commandReceipts.close(),
      () => subtaskStore.close(),
      () => mcpManifestStore.close(),
      () => extensionManifestStore.close(),
      () => extensionPlanStore.close(),
      () => providerProfileStore.close(),
      () => skillPackStore.close(),
      () => agentAdapterManifestStore.close(),
      () => agentAdapterSessionStore.close(),
      () => agentAdapterMailboxStore.close(),
      () => scheduleManifestStore.close(),
      () => scheduledRunStore.close(),
      () => runTrajectoryStore.close(),
      () => administratorLeaseStore.close(),
      () => trustedDesktopIssuerStore.close(),
    ];
    let closeFailure: unknown;
    for (const close of closers) {
      try {
        close();
      } catch (error) {
        closeFailure ??= error;
      }
    }
    if (closeFailure) throw closeFailure;
  };

  return {
    dependencies: {
      runtime, commandReceipts, readOnlySubtasks, mcpRegistry, extensionRegistry, extensionPlanStore,
      extensionActivationPlanner, extensionDoctor, providerProfiles, localModelHealth, knowledgeWorkspaces, skillPacks,
      agentAdapters, schedules, runTrajectory, administratorLeases, trustedDesktopIssuers,
      controlPlaneDiagnostics: () => createControlPlaneDiagnosticReport({
        extensions: extensionRegistry,
        extensionDoctor,
        skillPacks,
        providerProfiles,
        localModels: localModelHealth,
        trustedDesktopIssuers,
      }),
      defaultKnowledgeWorkspaceId: DEFAULT_KNOWLEDGE_WORKSPACE_ID,
      requests, eventsByRun, approvedActions, createTaskRequest, createEvent,
    },
    close: closeResources,
  };
}

export interface LocalGatewayApplication {
  /** 仅在绑定 loopback port 后 resolve；对外不暴露 server、socket 或执行能力。 */
  readonly ready: Promise<number>;
  close(): void;
}

/** 进程无关的 HTTP host：组合根只在启动时创建，信号处理仍由 main.ts 单独负责。 */
export function startLocalGateway(port = PORT): LocalGatewayApplication {
  const composition = createGatewayComposition();
  const server = createServer((request, response) => { void handleGatewayRequest(request, response, composition.dependencies); });
  const ready = new Promise<number>((resolvePort, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Gateway 未返回 TCP 监听地址'));
        return;
      }
      console.log(`AI Work OS runtime gateway listening on http://127.0.0.1:${address.port}`);
      resolvePort(address.port);
    });
  });
  return {
    ready,
    close(): void {
      server.close(() => composition.close());
    },
  };
}
