import { createServer } from 'node:http';import { resolve } from 'node:path';
import type { CapabilityPolicyRule } from '@awo/protocol';
import {
  AdministratorAuthorityLedger,
  AgentAdapterControlPlane,
  ApiUsageLedger,
  ComponentLockfileLedger,
  AuthenticatedNativeComponentManagementBridge, ComponentManagementAuthority,
  ComponentProvenanceRegistry,
  AuditedScheduleControlPlane,
  ExtensionActivationPlanner,
  ExtensionDoctor,
  ExtensionRegistry,
  McpRegistry,
  ReadOnlySubtaskService,
  RuleBasedCapabilityPolicy,
  RunTrajectoryLedger,
  SqliteAdapterApprovalMailboxStore,
  SqliteApiUsageStore,
  SqliteAdministratorLeaseStore,
  SqliteComponentLockfileStore,
  SqliteComponentManagementReceiptStore,
  SqliteComponentProvenanceStore,
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
} from '@awo/agent-runtime';
import {
  AgencyRoleCatalog,
  KnowledgeImportSessionRegistry,
  KnowledgeWorkspaceService,
  SkillPackRegistry,
  SqliteKnowledgeImportSessionStore,
  SqliteKnowledgeWorkspaceStore,
  SqliteSkillPackStore,
  SqliteWorkspaceKnowledgeStoreFactory,
} from '@awo/knowledge-workflow';
import {
  BUILT_IN_PROVIDER_CATALOG,
  EnvironmentCredentialResolver,
  SessionCredentialResolver,
  LocalModelHealthRegistry,
  MimoTtsService, ProviderConnectionService,
  ProviderInferenceService,
  ProviderProfileRegistry,
  SqliteProviderProfileStore, SessionCustomProviderService,
} from '@awo/provider-sdk';
import type { GatewayDependencies } from './http/gateway-dependencies.js';
import { createControlPlaneDiagnosticReport } from './control-plane-diagnostics.js';
import { createGatewaySecurityPostureReport } from './security-posture-audit.js';
import { createGatewayComponentLockReport, createGatewayExtensionProvenanceLockGuard } from './component-lock-report.js';
import { createGatewayComponentManagementReport } from './component-management-report.js';
import { createNativeHostAuthenticationComposition } from './native-host-authentication-composition.js';
import { createWindowsNativeReleaseComposition } from './windows-native-release-composition.js';
import { createTaskFileWorkspaceComposition } from './task-file-workspace-composition.js'; import { createProjectWorkspaceComposition } from './project-workspace-composition.js'; import { createTaskRuntimeComposition } from './task-runtime-composition.js'; import { createTaskModelInferencePort } from './task-model-inference.js';
import { createBrowserSessionComposition } from './browser-session-composition.js';
import { handleGatewayRequest } from './http/router.js';
const PORT = Number(process.env.AWO_RUNTIME_PORT ?? 4318); const DEFAULT_KNOWLEDGE_WORKSPACE_ID = 'default-local';
const BASELINE_RULES: readonly CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: '本地任务模板允许文档解析' },
  { capability: 'model.chat', decision: 'allow', reason: '本地任务模板允许受控模型推理' },
  { capability: 'filesystem.read', decision: 'allow', reason: '本地任务模板允许只读检查' },
  { capability: 'filesystem.write', decision: 'require_approval', reason: '写入意图必须经本地审批' },
  { capability: 'network.fetch', decision: 'require_approval', reason: '网络访问必须经本地审批' },
  { capability: 'shell.execute', decision: 'require_approval', reason: 'Shell 执行必须经本地审批' },
  { capability: 'browser.control', decision: 'require_approval', reason: '浏览器控制必须经本地审批' },
];
/** 仅由已完成平台进程/二进制身份验证的 native adapter 持有；不传入 HTTP router 或 renderer。 */
export interface GatewayNativeHostPort { readonly componentManagement: AuthenticatedNativeComponentManagementBridge; readonly releaseEvidence: import('@awo/agent-runtime').WindowsNativeHostReleaseEvidenceLedger; }
export interface GatewayComposition { readonly dependencies: GatewayDependencies; readonly nativeHost: GatewayNativeHostPort; close(): void; }
/** 唯一 composition root：读取本地配置、创建 SQLite adapter 并注入领域控制面；模块导入不分配资源。 */
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
  const apiUsagePath = resolve(process.env.AWO_API_USAGE_DB ?? '.awo/api-usage.sqlite');
  const browserSessionPath = resolve(process.env.AWO_BROWSER_SESSION_DB ?? '.awo/browser-sessions.sqlite');
  const skillPackPath = resolve(process.env.AWO_SKILL_PACK_DB ?? '.awo/skill-packs.sqlite');
  const knowledgeImportPath = resolve(process.env.AWO_KNOWLEDGE_IMPORT_DB ?? '.awo/knowledge-imports.sqlite');
  const agentAdapterManifestPath = resolve(process.env.AWO_AGENT_ADAPTER_MANIFEST_DB ?? '.awo/agent-adapters.sqlite');
  const agentAdapterSessionPath = resolve(process.env.AWO_AGENT_ADAPTER_SESSION_DB ?? '.awo/agent-adapter-sessions.sqlite');
  const agentAdapterMailboxPath = resolve(process.env.AWO_AGENT_ADAPTER_MAILBOX_DB ?? '.awo/agent-adapter-mailbox.sqlite');
  const scheduleManifestPath = resolve(process.env.AWO_SCHEDULE_MANIFEST_DB ?? '.awo/audited-schedules.sqlite');
  const scheduleRunPath = resolve(process.env.AWO_SCHEDULE_RUN_DB ?? '.awo/audited-schedule-runs.sqlite');
  const runTrajectoryPath = resolve(process.env.AWO_RUN_TRAJECTORY_DB ?? '.awo/run-trajectories.sqlite');
  const runWorkspaceLedgerPath = resolve(process.env.AWO_RUN_WORKSPACE_LEDGER_DB ?? '.awo/run-workspace-ledger.sqlite');
  const taskFileWorkspacePath = resolve(process.env.AWO_TASK_FILE_WORKSPACE_DB ?? '.awo/task-file-workspace.sqlite');
  const taskFileRoot = resolve(process.env.AWO_TASK_FILE_ROOT ?? '.awo/task-file-workspace');
  const administratorLeasePath = resolve(process.env.AWO_ADMINISTRATOR_LEASE_DB ?? '.awo/administrator-leases.sqlite');
  const trustedDesktopIssuerPath = resolve(process.env.AWO_TRUSTED_DESKTOP_ISSUER_DB ?? '.awo/trusted-desktop-issuers.sqlite');
  const componentProvenancePath = resolve(process.env.AWO_COMPONENT_PROVENANCE_DB ?? '.awo/component-provenance.sqlite');
  const componentLockfilePath = resolve(process.env.AWO_COMPONENT_LOCKFILE_DB ?? '.awo/component-lockfile.sqlite');
  const componentManagementReceiptPath = resolve(process.env.AWO_COMPONENT_MANAGEMENT_RECEIPT_DB ?? '.awo/component-management-receipts.sqlite');
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
  const apiUsageStore = new SqliteApiUsageStore(apiUsagePath);
  const apiUsage = new ApiUsageLedger(apiUsageStore);
  const browserSessionComposition = createBrowserSessionComposition(browserSessionPath);
  const { browserSessions } = browserSessionComposition;
  // 仅 composition root 允许从本机 Gateway 进程环境取得凭据；route、Profile SQLite 与 WebView 均不可见。
  const providerCredentials = new SessionCredentialResolver(new EnvironmentCredentialResolver((name) => process.env[name]));
  const providerConnections = new ProviderConnectionService(BUILT_IN_PROVIDER_CATALOG, providerProfiles, providerCredentials);
  const providerInference = new ProviderInferenceService(BUILT_IN_PROVIDER_CATALOG, providerProfiles, providerCredentials, undefined, undefined, (providerId) => providerConnections.resolveSessionProvider(providerId));
  const mimoTts = new MimoTtsService(BUILT_IN_PROVIDER_CATALOG, providerProfiles, providerCredentials);
  const customProviders = new SessionCustomProviderService(providerCredentials);
  const localModelHealth = new LocalModelHealthRegistry();
  const skillPackStore = new SqliteSkillPackStore(skillPackPath);
  const skillPacks = new SkillPackRegistry(skillPackStore);
  const agencyRoles = new AgencyRoleCatalog();
  const knowledgeImportStore = new SqliteKnowledgeImportSessionStore(knowledgeImportPath);
  const knowledgeImports = new KnowledgeImportSessionRegistry(knowledgeImportStore);
  const agentAdapterManifestStore = new SqliteAgentAdapterManifestStore(agentAdapterManifestPath);
  const agentAdapterSessionStore = new SqliteAgentAdapterSessionStore(agentAdapterSessionPath);
  const agentAdapterMailboxStore = new SqliteAdapterApprovalMailboxStore(agentAdapterMailboxPath);
  const agentAdapters = new AgentAdapterControlPlane(agentAdapterManifestStore, agentAdapterSessionStore, agentAdapterMailboxStore);
  const scheduleManifestStore = new SqliteScheduleManifestStore(scheduleManifestPath);
  const scheduledRunStore = new SqliteScheduledRunStore(scheduleRunPath);
  const schedules = new AuditedScheduleControlPlane(scheduleManifestStore, scheduledRunStore);
  const runTrajectoryStore = new SqliteRunTrajectoryStore(runTrajectoryPath); const runTrajectory = new RunTrajectoryLedger(runTrajectoryStore);
  const taskFileWorkspace = createTaskFileWorkspaceComposition(runWorkspaceLedgerPath, taskFileWorkspacePath, taskFileRoot);
  const { runWorkspace, taskFiles } = taskFileWorkspace;
  const projectWorkspace = createProjectWorkspaceComposition(resolve(process.env.AWO_PROJECT_WORKSPACE_DB ?? '.awo/local-projects.sqlite'));
  const { projects } = projectWorkspace;
  const administratorLeaseStore = new SqliteAdministratorLeaseStore(administratorLeasePath);
  const administratorLeases = new AdministratorAuthorityLedger(administratorLeaseStore);
  const trustedDesktopIssuerStore = new SqliteTrustedDesktopIssuerStore(trustedDesktopIssuerPath);
  const trustedDesktopIssuers = new TrustedDesktopIssuerRegistry(trustedDesktopIssuerStore);
  const componentProvenanceStore = new SqliteComponentProvenanceStore(componentProvenancePath);
  const componentProvenances = new ComponentProvenanceRegistry(componentProvenanceStore);
  const componentLockfileStore = new SqliteComponentLockfileStore(componentLockfilePath);
  const componentLockfiles = new ComponentLockfileLedger(componentLockfileStore);
  const componentManagementReceiptStore = new SqliteComponentManagementReceiptStore(componentManagementReceiptPath);
  const componentManagement = new ComponentManagementAuthority(trustedDesktopIssuers, componentProvenances, componentLockfiles, componentManagementReceiptStore);
  const nativeHostAuthentication = createNativeHostAuthenticationComposition({
    bridgeTrustPath: resolve(process.env.AWO_NATIVE_HOST_BRIDGE_TRUST_DB ?? '.awo/native-host-bridge-trust.sqlite'),
    challengePath: resolve(process.env.AWO_NATIVE_HOST_CHALLENGE_DB ?? '.awo/native-host-challenges.sqlite'),
    issuers: trustedDesktopIssuers,
    componentManagement,
  });
  const windowsNativeRelease = createWindowsNativeReleaseComposition(resolve(process.env.AWO_WINDOWS_NATIVE_RELEASE_EVIDENCE_DB ?? '.awo/windows-native-release-evidence.sqlite'));
  if (!knowledgeWorkspaceStore.load(DEFAULT_KNOWLEDGE_WORKSPACE_ID)) {
    knowledgeWorkspaces.create({
      id: DEFAULT_KNOWLEDGE_WORKSPACE_ID,
      title: '默认本地知识库',
      description: '为兼容本地工作台知识检索创建的受控默认工作区。',
      at: Date.now(),
    });
  }
  const taskRuntime = createTaskRuntimeComposition({
    snapshotStore: store,
    baselineRules: BASELINE_RULES,
    administratorLeases,
    runTrajectory,
    runWorkspace,
    taskFiles,
    modelInference: createTaskModelInferencePort(providerConnections, providerInference),
  });
  const extensionActivationPlanner = new ExtensionActivationPlanner(
    extensionRegistry,
    new RuleBasedCapabilityPolicy(BASELINE_RULES),
    extensionPlanStore,
    createGatewayExtensionProvenanceLockGuard(componentProvenances, componentLockfiles),
  );
  const extensionDoctor = new ExtensionDoctor(extensionRegistry);
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
      () => apiUsageStore.close(),
      () => browserSessionComposition.close(),
      () => skillPackStore.close(),
      () => knowledgeImportStore.close(),
      () => agentAdapterManifestStore.close(),
      () => agentAdapterSessionStore.close(),
      () => agentAdapterMailboxStore.close(),
      () => scheduleManifestStore.close(),
      () => scheduledRunStore.close(),
      () => { runTrajectoryStore.close(); taskFileWorkspace.close(); projectWorkspace.close(); },
      () => administratorLeaseStore.close(),
      () => trustedDesktopIssuerStore.close(),
      () => componentProvenanceStore.close(),
      () => componentLockfileStore.close(),
      () => componentManagementReceiptStore.close(),
      () => nativeHostAuthentication.close(),
      () => windowsNativeRelease.close(),
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
      ...taskRuntime, commandReceipts, readOnlySubtasks, mcpRegistry, extensionRegistry, extensionPlanStore,
      extensionActivationPlanner, extensionDoctor, providerProfiles, providerConnections, providerInference, mimoTts, customProviders, apiUsage, browserSessions, localModelHealth, knowledgeWorkspaces, knowledgeImports, agencyRoles, skillPacks,
      agentAdapters, schedules, runTrajectory, runWorkspace, taskFiles, projects, administratorLeases, trustedDesktopIssuers,
      controlPlaneDiagnostics: () => createControlPlaneDiagnosticReport({
        extensions: extensionRegistry,
        extensionDoctor,
        skillPacks,
        providerProfiles,
        localModels: localModelHealth,
        trustedDesktopIssuers,
      }),
      nativeHostAuthenticationReport: () => nativeHostAuthentication.report(),
      windowsNativeReleaseReport: () => windowsNativeRelease.report(),
      componentManagementReport: () => createGatewayComponentManagementReport(componentManagement),
      componentLockReport: () => createGatewayComponentLockReport({
        extensions: extensionRegistry,
        skillPacks,
        agentAdapters,
        provenances: componentProvenances,
        lockfiles: componentLockfiles,
      }),
      securityPostureAudit: () => createGatewaySecurityPostureReport({
        extensions: extensionRegistry,
        extensionDoctor,
        providerProfiles,
        localModels: localModelHealth,
        trustedDesktopIssuers,
      }),
      defaultKnowledgeWorkspaceId: DEFAULT_KNOWLEDGE_WORKSPACE_ID,
    },
    nativeHost: { ...nativeHostAuthentication.nativeHost, ...windowsNativeRelease.nativeHost },
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
