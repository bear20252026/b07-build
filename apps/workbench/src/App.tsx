import { useEffect, useState } from 'react';
/* Unsloth-inspired UI alignment only: preserve direct Provider and streaming behaviour. */
import './components/observability/GatewayAttachment.css';
import { invoke } from '@tauri-apps/api/core';
import type { AgentProfileId, TaskEvent } from '@awo/protocol';
import { Sider, type WorkbenchPage } from './components/layout/Sider';
import { SettingsOverlay } from './components/layout/SettingsOverlay';
import { WorkbenchOverlay } from './components/layout/WorkbenchOverlay';
import { CommandPalette } from './components/layout/CommandPalette';
import { createWorkbenchCommandCatalog, type WorkbenchCommand } from './components/layout/command-catalog';
import { resolveWorkbenchSurface } from './components/layout/workbench-surface';
import { ControlPlaneDiagnosticsBoard } from './components/observability/ControlPlaneDiagnosticsBoard';
import { ComponentLockBoard } from './components/observability/ComponentLockBoard';
import { ComponentManagementReceiptBoard } from './components/observability/ComponentManagementReceiptBoard';
import { ExtensionCenter } from './components/observability/ExtensionCenter';
import { LocalModelHealthBoard } from './components/observability/LocalModelHealthBoard';
import { ApiUsageAuditPage, ApiUsageSummaryCard } from './components/observability/ApiUsageBoards';
import { AgencyRoleCatalogPage } from './components/observability/AgencyRoleCatalogPage';
import { BrowserSessionControlPage, BrowserSessionSummaryCard } from './components/observability/BrowserSessionControlPanel';
import { CompanionControlPage, CompanionSummaryCard } from './components/observability/CompanionControlPanel';
import { CompanionWindow } from './components/observability/CompanionWindow';
import { CompanionStudioPage, CompanionStudioSummary } from './components/observability/CompanionStudioPanel';
import { KnowledgeImportPanel } from './components/observability/KnowledgeImportPanel';
import { ProviderSetupPage } from './components/settings/ProviderSetupPage';
import { ProviderConnectionCenter } from './components/observability/ProviderConnectionCenter';
import { NativeHostAuthenticationBoard } from './components/observability/NativeHostAuthenticationBoard';
import { WindowsNativeReleaseBoard } from './components/observability/WindowsNativeReleaseBoard';
import { SecurityPostureAuditBoard } from './components/observability/SecurityPostureAuditBoard';
import { TrajectoryBoard } from './components/observability/TrajectoryBoard';
import { RunWorkspaceBoard } from './components/observability/RunWorkspaceBoard';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { ChatHome } from './components/workspace/ChatHome';
import { ComposerAttachments, mergeComposerFileAttachments, type ComposerFileAttachment } from './components/workspace/ComposerAttachments';
import { WORKBENCH_PROFILE_IDS } from './components/workspace/agent-profiles';
import { LocalDataFlowBoard } from './components/workspace/LocalDataFlowBoard';
import { TaskStoryboard } from './components/workspace/TaskStoryboard';
import { TaskOutcomeBoard } from './components/workspace/TaskOutcomeBoard';
import { TaskPage } from './components/workspace/TaskPage';
import { HomeFloatingCompanion } from './components/workspace/HomeFloatingCompanion';
import { DesktopCompanionSurface } from './components/workspace/DesktopCompanionSurface';
import { WorkspaceFilesPage } from './components/workspace/WorkspaceFilesPage';
import { TerminalCodingPage } from './components/workspace/TerminalCodingPage';
import { ProjectBoard } from './components/workspace/ProjectBoard';
import { useLocale } from './i18n/LocaleProvider';
import type { Translation } from './i18n/catalog';
import {
  HttpWorkbenchTaskClient,
  type WorkbenchAuthorityMode,
  type WorkbenchComponentLockReport,
  type WorkbenchComponentManagementReport,
  type WorkbenchControlPlaneDiagnostics,
  type WorkbenchLocalModelHealth,
  type WorkbenchNativeHostAuthenticationReport,
  type WorkbenchWindowsNativeReleaseReport,
  type WorkbenchTaskSnapshot,
  type WorkbenchSecurityPostureReport,
} from './runtime/task-client';
import { createProjectClient } from './runtime/project-client';
import { useProjectWorkspace } from './runtime/use-project-workspace';
import { useProviderControlPlane } from './runtime/use-provider-control-plane';
import { useDirectConversations } from './runtime/use-direct-conversations';
import { useTaskExecution } from './runtime/use-task-execution';
import { loadCompanionPreferences, saveCompanionPreferences, updateCompanionPreferences } from './runtime/companion-preferences';
import { loadFloatingCompanionPreferences, saveFloatingCompanionPreferences, type FloatingCompanionPreferencesV1 } from './runtime/floating-companion-preferences';
import { loadCompanionStudioPreferences, saveCompanionStudioPreferences, updateCompanionStudioPreferences } from './runtime/companion-studio-preferences';
import { loadWorkspaceFilePreferences, saveWorkspaceFilePreferences, type WorkspaceFilePreferencesV1 } from './runtime/workspace-file-contract';

const localGatewayClient = HttpWorkbenchTaskClient.forLocalGateway();
const localProjectClient = createProjectClient();

function loadTaskModelSelection(): Readonly<{ providerId: string; model?: string }> | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem('awo.direct-provider.selection.v1') ?? '') as { providerId?: unknown; model?: unknown };
    if (typeof value.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.providerId)) return undefined;
    if (value.model !== undefined && (typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model))) return undefined;
    return { providerId: value.providerId, ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}) };
  } catch { return undefined; }
}

function profileUi(messages: Translation): Record<AgentProfileId, { label: string; description: string }> {
  return messages.profile;
}

function eventPresentation(event: TaskEvent, messages: Translation): { title: string; detail: string; tone: string } {
  switch (event.type) {
    case 'task.created':
      return { ...messages.event.created(event.goal), tone: '' };
    case 'agent.profile.selected': {
      const profile = profileUi(messages)[event.profileId];
      return { ...messages.event.profile(profile.label, profile.description), tone: 'success' };
    }
    case 'execution.authority.selected':
      return { ...messages.event.authority(messages.authority.mode[event.authorityMode].label), tone: 'success' };
    case 'input.provenance.recorded':
      return {
        ...messages.event.provenance(
          event.provenance.length,
          event.provenance.filter((input) => input.trust === 'external-untrusted').length,
          event.provenance.filter((input) => input.trust === 'derived-untrusted').length,
        ),
        tone: 'warn',
      };
    case 'plan.proposed':
      return { ...messages.event.plan(event.steps.length), tone: '' };
    case 'approval.required':
      return { ...messages.event.approvalRequired(event.capability, event.reason), tone: 'warn' };
    case 'approval.resolved':
      return { ...messages.event.approvalResolved(event.decision === 'approved', event.actionId, event.resolvedBy), tone: event.decision === 'approved' ? 'success' : 'danger' };
    case 'tool.called':
      return { ...messages.event.toolCalled(event.tool.name, event.tool.capability, event.tool.risk), tone: '' };
    case 'tool.result':
      return { ...messages.event.toolResult(event.status === 'ok', event.reason ?? event.outputRef), tone: event.status === 'ok' ? 'success' : 'danger' };
    case 'artifact.created':
      return { ...messages.event.artifact(event.mime, event.path), tone: 'success' };
    case 'task.completed':
      return { ...messages.event.completed(event.summaryRef), tone: 'success' };
    case 'task.failed':
      return { ...messages.event.failed(event.code, event.message), tone: 'danger' };
    case 'context.compacted':
      return { ...messages.event.compacted(event.estimatedTokensBefore, event.estimatedTokensAfter), tone: 'warn' };
    case 'execution.blocked':
      return { ...messages.event.blocked(event.code, event.reason), tone: 'warn' };
  }
}

function statusLabel(status: WorkbenchTaskSnapshot['status'] | undefined, messages: Translation): string {
  if (!status) return messages.task.status.idle;
  return messages.task.status[status];
}

function gatewayErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/Failed to fetch|DOCTYPE|Unexpected token|JSON/i.test(message)) return '未收到可用的 Gateway 响应。应用会在连接模型时按需启动本机服务；请稍候或重试。';
  if (/aborted|timeout/i.test(message)) return '本机 Gateway 暂未就绪或供应商响应超时。请稍候重试，并检查模型名称和 API key。';
  return message && !/[<{]/.test(message) ? message : '连接请求未完成。请检查 Gateway 状态后重试。';
}

export function App() {
  const [activePage, setActivePage] = useState<WorkbenchPage>('workspace');
  const [gatewayAttached, setGatewayAttached] = useState(false);
  const [gatewayAttachmentError, setGatewayAttachmentError] = useState<string>();
  const [attachingGateway, setAttachingGateway] = useState(false);
  const [localModels, setLocalModels] = useState<readonly WorkbenchLocalModelHealth[]>();
  const [localModelError, setLocalModelError] = useState<string>();
  const [controlPlaneDiagnostics, setControlPlaneDiagnostics] = useState<WorkbenchControlPlaneDiagnostics>();
  const [controlPlaneDiagnosticError, setControlPlaneDiagnosticError] = useState<string>();
  const [securityPostureAudit, setSecurityPostureAudit] = useState<WorkbenchSecurityPostureReport>();
  const [securityPostureAuditError, setSecurityPostureAuditError] = useState<string>();
  const [componentLockReport, setComponentLockReport] = useState<WorkbenchComponentLockReport>();
  const [componentLockReportError, setComponentLockReportError] = useState<string>();
  const [componentManagementReport, setComponentManagementReport] = useState<WorkbenchComponentManagementReport>();
  const [componentManagementReportError, setComponentManagementReportError] = useState<string>();
  const [nativeHostAuthenticationReport, setNativeHostAuthenticationReport] = useState<WorkbenchNativeHostAuthenticationReport>();
  const [nativeHostAuthenticationReportError, setNativeHostAuthenticationReportError] = useState<string>();
  const [windowsNativeReleaseReport, setWindowsNativeReleaseReport] = useState<WorkbenchWindowsNativeReleaseReport>();
  const [windowsNativeReleaseReportError, setWindowsNativeReleaseReportError] = useState<string>();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [draft, setDraft] = useState('');
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [composerAttachments, setComposerAttachments] = useState<readonly ComposerFileAttachment[]>([]);
  const [inspectorSurface, setInspectorSurface] = useState<'api' | 'artifacts' | 'companion' | 'workspace-files' | 'terminal-coding'>();
  const [activeGoal, setActiveGoal] = useState<string>();
  const [activeProfile, setActiveProfile] = useState<AgentProfileId>('build');
  const [authorityMode, setAuthorityMode] = useState<WorkbenchAuthorityMode>('review');
  const [taskModelSelection, setTaskModelSelection] = useState<Readonly<{ providerId: string; model?: string }> | undefined>(loadTaskModelSelection);
  const [directSetupError, setDirectSetupError] = useState<string>();
  const [companionPreferences, setCompanionPreferences] = useState(() => loadCompanionPreferences());
  const [floatingCompanionPreferences, setFloatingCompanionPreferences] = useState(() => loadFloatingCompanionPreferences());
  const [companionStudioPreferences, setCompanionStudioPreferences] = useState(() => loadCompanionStudioPreferences());
  const [workspaceFilePreferences, setWorkspaceFilePreferences] = useState(() => loadWorkspaceFilePreferences());
  const { messages } = useLocale();
  const taskExecution = useTaskExecution(gatewayAttached, {
    gatewayRequired: '请先显式附着本机 Gateway；桌面应用不会自动启动或连接服务。',
    submitFailed: messages.task.error.connect,
    resumeFailed: messages.task.error.resume,
    approvalFailed: messages.task.error.approve,
  }, localGatewayClient);
  const { snapshot, events, trajectory, workspaceArtifacts, checkpoints, taskFiles, deliveries, pending, deliveryPending, error: serviceError } = taskExecution;
  const projectWorkspace = useProjectWorkspace(activePage, gatewayErrorText, localProjectClient);
  const providerControl = useProviderControlPlane();
  const directConversations = useDirectConversations();
  const profiles = profileUi(messages);
  const profile = profiles[activeProfile];
  const selectTaskModel = (selection: Readonly<{ providerId: string; model?: string }>): void => {
    setTaskModelSelection(selection);
    window.localStorage.setItem('awo.direct-provider.selection.v1', JSON.stringify(selection));
  };
  useEffect(() => {
    if (taskModelSelection || providerControl.connections.length === 0) return;
    const connection = providerControl.connections[0];
    selectTaskModel({ providerId: connection.providerId, ...(connection.defaultModel ? { model: connection.defaultModel } : {}) });
  }, [providerControl.connections, taskModelSelection]);
  const selectedTaskConnection = providerControl.connections?.find((connection) => connection.providerId === taskModelSelection?.providerId);
  const taskModelLabel = selectedTaskConnection ? `${selectedTaskConnection.displayName} · ${taskModelSelection?.model ?? selectedTaskConnection.defaultModel}` : undefined;
  const updateCompanion = (change: Parameters<typeof updateCompanionPreferences>[1]): void => setCompanionPreferences((current) => {
    const next = updateCompanionPreferences(current, change);
    saveCompanionPreferences(next);
    return next;
  });
  const updateCompanionStudio = (change: Parameters<typeof updateCompanionStudioPreferences>[1]): void => setCompanionStudioPreferences((current) => { const next = updateCompanionStudioPreferences(current, change); saveCompanionStudioPreferences(next); return next; });
  const updateFloatingCompanion = (next: FloatingCompanionPreferencesV1): void => { saveFloatingCompanionPreferences(next); setFloatingCompanionPreferences(next); };
  const updateWorkspaceFiles = (next: WorkspaceFilePreferencesV1): void => { saveWorkspaceFilePreferences(next); setWorkspaceFilePreferences(next); };
  const addComposerAttachments = (files: FileList | null): void => setComposerAttachments((current) => mergeComposerFileAttachments(current, files));
  const removeComposerAttachment = (id: string): void => setComposerAttachments((current) => current.filter((item) => item.descriptor.id !== id));
  const pageTitle: Record<WorkbenchPage, string> = { workspace: messages.task.title, projects: '项目', task: '当前任务', models: 'API 连接', connections: '已连接模型', operations: '运行记录', 'api-usage': 'API 使用审计', 'workspace-files': '工作区与文件', 'terminal-coding': '终端与编码', capabilities: '扩展与能力', 'agency-roles': '预置专业角色', 'browser-sessions': '浏览会话控制', companion: 'Companion Agent', 'companion-service-sources': '服务来源', 'companion-body-modules': '机体模块', 'companion-character-models': '角色模型', 'companion-character-cards': 'AIRI 角色卡', 'companion-system': 'Companion 系统', security: '安全与系统' };
  const blockedNodeId = snapshot && Object.entries(snapshot.nodeOutcomes).find(([, outcome]) => outcome === 'blocked')?.[0];
  const provenance = snapshot?.inputProvenance ?? [];
  const untrustedInputCount = provenance.filter((input) => input.trust === 'external-untrusted' || input.trust === 'derived-untrusted').length;
  const workbenchSurface = resolveWorkbenchSurface({ activePage, hasTaskSnapshot: Boolean(snapshot) });
  const isTaskPage = workbenchSurface === 'task-page';
  const isProjectPage = workbenchSurface === 'project-page';
  const isSettings = workbenchSurface === 'settings';
  const commandCatalog = createWorkbenchCommandCatalog({ hasActiveTask: Boolean(snapshot) });

  useEffect(() => {
    if (!gatewayAttached || activePage !== 'capabilities') return;
    let disposed = false;
    void localGatewayClient.localModelHealth().then((models) => { if (!disposed) setLocalModels(models); }).catch((error: unknown) => { if (!disposed) setLocalModelError(gatewayErrorText(error)); });
    void localGatewayClient.controlPlaneDiagnostics().then((report) => { if (!disposed) setControlPlaneDiagnostics(report); }).catch((error: unknown) => { if (!disposed) setControlPlaneDiagnosticError(gatewayErrorText(error)); });
    return () => { disposed = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayAttached, activePage]);

  useEffect(() => {
    if (!gatewayAttached || activePage !== 'security') return;
    let disposed = false;
    void localGatewayClient.securityPostureAudit().then((report) => { if (!disposed) setSecurityPostureAudit(report); }).catch((error: unknown) => { if (!disposed) setSecurityPostureAuditError(gatewayErrorText(error)); });
    void localGatewayClient.componentLockReport().then((report) => { if (!disposed) setComponentLockReport(report); }).catch((error: unknown) => { if (!disposed) setComponentLockReportError(gatewayErrorText(error)); });
    void localGatewayClient.componentManagementReport().then((report) => { if (!disposed) setComponentManagementReport(report); }).catch((error: unknown) => { if (!disposed) setComponentManagementReportError(gatewayErrorText(error)); });
    void localGatewayClient.nativeHostAuthenticationReport().then((report) => { if (!disposed) setNativeHostAuthenticationReport(report); }).catch((error: unknown) => { if (!disposed) setNativeHostAuthenticationReportError(gatewayErrorText(error)); });
    void localGatewayClient.windowsNativeReleaseReport().then((report) => { if (!disposed) setWindowsNativeReleaseReport(report); }).catch((error: unknown) => { if (!disposed) setWindowsNativeReleaseReportError(gatewayErrorText(error)); });
    return () => { disposed = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayAttached, activePage]);

  const submitIntent = async (): Promise<void> => {
    const goal = draft.trim();
    if (!goal) return;
    if (providerControl.restoring) {
      setDirectSetupError('正在恢复本地模型会话，请稍候再发送。');
      return;
    }
    if (!taskModelSelection || !selectedTaskConnection) {
      setDirectSetupError('请先在 API 连接中完成模型连接并选择任务模型；首页不会回退到旧的本机 Gateway 链路。');
      return;
    }
    setDirectSetupError(undefined);
    {
      const sent = await directConversations.send(taskModelSelection, goal);
      if (!sent) return;
      setActiveGoal(goal);
      setComposerAttachments([]);
      setDraft('');
      setActivePage('workspace');
      return;
    }
  };

  const approveAndResume = async (): Promise<void> => {
    if (!blockedNodeId) return;
    await taskExecution.approveAndResume(blockedNodeId);
  };

  const focusTaskInspector = (): void => {
    document.getElementById('task-inspector')?.focus();
  };

  const focusTaskComposer = (): void => {
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(`[aria-label="${messages.task.goalAria}"]`)?.focus(), 0);
  };

  const useSuggestedGoal = (goal: string): void => {
    setDraft(goal);
    focusTaskComposer();
  };

  const executeCommand = (command: WorkbenchCommand): void => {
    switch (command.action.kind) {
      case 'navigate':
        setActivePage(command.action.page);
        return;
      case 'focus-task-composer':
        setActivePage('workspace');
        focusTaskComposer();
        return;
      case 'focus-task-inspector':
        if (!snapshot) return;
        setActivePage('task');
        window.setTimeout(focusTaskInspector, 0);
        return;
    }
  };

  const isDesktopCompanionWindow = typeof window !== 'undefined' && (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__?.metadata?.currentWindow?.label === 'desktop-companion';
  const openDesktopCompanion = (): void => { void invoke('show_desktop_companion').catch((error: unknown) => setGatewayAttachmentError(gatewayErrorText(error))); };
  if (isDesktopCompanionWindow) return <DesktopCompanionSurface />;

  const settingsContent = <>
    {activePage === 'models' && <ProviderSetupPage connections={providerControl.connections} discoveredModels={providerControl.discoveredModels} error={providerControl.error} pendingProviderId={providerControl.pendingProviderId} onConfigure={providerControl.configure} onConfigureCustom={providerControl.configureCustom} onDiscoverModels={providerControl.discoverModels} onManageConnections={() => setActivePage('connections')} />}
    {activePage === 'connections' && <section className="page-stack"><div className="page-heading"><span>CONNECTED MODELS</span><h1>已连接模型</h1><p>保存连接后，在此页查询模型目录、选择模型、检查连接状态，或发送一次受限文本请求。</p></div><ProviderConnectionCenter connections={providerControl.connections} probes={providerControl.probes} discoveredModels={providerControl.discoveredModels} inferences={providerControl.inferences} streaming={providerControl.streaming} taskModelSelection={taskModelSelection} error={providerControl.error} pendingProviderId={providerControl.pendingProviderId} onRefresh={providerControl.refresh} onProbe={providerControl.probe} onDiscoverModels={providerControl.discoverModels} onSelectTaskModel={selectTaskModel} onInfer={providerControl.infer} onStream={providerControl.stream} /></section>}
    {activePage === 'workspace-files' && <WorkspaceFilesPage preferences={workspaceFilePreferences} onChange={updateWorkspaceFiles} />}
    {activePage === 'terminal-coding' && <TerminalCodingPage workspace={workspaceFilePreferences} />}
    {activePage === 'operations' && <section className="page-stack"><div className="page-heading"><span>RUN RECORDS</span><h1>运行记录</h1><p>检查点、产出账本与只读轨迹；它们可解释运行，但不能重放副作用。</p></div><ApiUsageSummaryCard gatewayAttached={gatewayAttached} onOpen={() => setActivePage('api-usage')} /><RunWorkspaceBoard artifacts={workspaceArtifacts} checkpoints={checkpoints} /><TrajectoryBoard events={trajectory} messages={messages} /></section>}
    {activePage === 'api-usage' && <ApiUsageAuditPage gatewayAttached={gatewayAttached} onBack={() => setActivePage('operations')} />}
    {activePage === 'capabilities' && <section className="page-stack"><div className="page-heading"><span>EXTENSIONS & CAPABILITIES</span><h1>扩展与能力</h1><p>按需读取扩展、本地模型与控制面摘要；此页不会启动模型、修改 Provider 或读取密钥。</p></div><CompanionSummaryCard preferences={companionPreferences} onOpen={() => setActivePage('companion')} /><CompanionStudioSummary preferences={companionStudioPreferences} onOpen={(section) => setActivePage(`companion-${section}` as WorkbenchPage)} /><BrowserSessionSummaryCard gatewayAttached={gatewayAttached} onOpen={() => setActivePage('browser-sessions')} /><section className="agency-role-entry"><div><span className="panel-eyebrow">LICENSED ROLE CATALOG</span><h2>预置专业角色</h2><p>浏览带 MIT 归因的专业角色，并仅在你明确操作后将某个角色添加为待审查的 Skill Pack 候选。</p></div><button title="进入三级角色目录，查看来源、版权、角色原文和候选添加动作。" onClick={() => setActivePage('agency-roles')} type="button">浏览角色目录 →</button></section><KnowledgeImportPanel gatewayAttached={gatewayAttached} /><ExtensionCenter taskId={snapshot?.taskId} runId={snapshot?.runId} /><LocalModelHealthBoard error={localModelError} messages={messages} models={localModels} /><ControlPlaneDiagnosticsBoard error={controlPlaneDiagnosticError} messages={messages} report={controlPlaneDiagnostics} /></section>}
    {activePage === 'agency-roles' && <AgencyRoleCatalogPage gatewayAttached={gatewayAttached} onBack={() => setActivePage('capabilities')} />}
    {activePage === 'browser-sessions' && <BrowserSessionControlPage gatewayAttached={gatewayAttached} onBack={() => setActivePage('capabilities')} />}
    {activePage === 'companion' && <CompanionControlPage gatewayAttached={gatewayAttached} preferences={companionPreferences} onBack={() => setActivePage('capabilities')} onUpdate={updateCompanion} />}
    {activePage === 'companion-service-sources' && <CompanionStudioPage preferences={companionStudioPreferences} section="service-sources" onBack={() => setActivePage('companion')} onUpdate={updateCompanionStudio} />}
    {activePage === 'companion-body-modules' && <CompanionStudioPage preferences={companionStudioPreferences} section="body-modules" onBack={() => setActivePage('companion')} onUpdate={updateCompanionStudio} />}
    {activePage === 'companion-character-models' && <CompanionStudioPage preferences={companionStudioPreferences} section="character-models" onBack={() => setActivePage('companion')} onUpdate={updateCompanionStudio} />}
    {activePage === 'companion-character-cards' && <CompanionStudioPage preferences={companionStudioPreferences} section="character-cards" onBack={() => setActivePage('companion')} onUpdate={updateCompanionStudio} />}
    {activePage === 'companion-system' && <CompanionStudioPage preferences={companionStudioPreferences} section="companion-system" onBack={() => setActivePage('companion')} onUpdate={updateCompanionStudio} />}
    {activePage === 'security' && <section className="page-stack"><div className="page-heading"><span>SECURITY & SYSTEM</span><h1>安全与系统</h1><p>所有项目均为只读证据与审计摘要；此页不能自动修复、信任或执行。</p></div><SecurityPostureAuditBoard error={securityPostureAuditError} messages={messages} report={securityPostureAudit} /><ComponentLockBoard error={componentLockReportError} messages={messages} report={componentLockReport} /><ComponentManagementReceiptBoard error={componentManagementReportError} messages={messages} report={componentManagementReport} /><NativeHostAuthenticationBoard error={nativeHostAuthenticationReportError} messages={messages} report={nativeHostAuthenticationReport} /><WindowsNativeReleaseBoard error={windowsNativeReleaseReportError} messages={messages} report={windowsNativeReleaseReport} /></section>}
  </>;

  return (
    <div className={`workbench-shell ${isTaskPage ? 'with-preview' : 'focus-page'}${workbenchSurface === 'chat-home' ? ' chat-home-surface' : ''}${isSettings ? ' settings-open' : ''} theme-${theme}`}>
      <Sider
        activePage={isSettings ? 'workspace' : activePage}
        hasActiveTask={Boolean(snapshot)}
        onNavigate={setActivePage}
        onNewTask={() => { setActivePage('workspace'); focusTaskComposer(); }}
        onThemeToggle={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
        theme={theme}
      />
      <main className="workbench-main">
        <header className="workbench-titlebar">
          <div>
            <div className="titlebar-kicker">AI WORK OS · THIRD-PARTY API</div>
            <div className="titlebar-title">{workbenchSurface === 'chat-home' && taskModelLabel ? taskModelLabel : pageTitle[activePage]}</div>
          </div>
          <div className="titlebar-actions">
            <CommandPalette commands={commandCatalog} onExecute={executeCommand} />
            <div aria-label="独立工作面" className="titlebar-surface-actions">
              <button aria-label="打开模型连接设置" className="titlebar-icon-button" onClick={() => setActivePage('models')} title="打开模型连接设置；在原有配置页面中填写地址和密钥。" type="button">⌁</button>
              <button aria-label="打开工作区文件窗口" className="titlebar-icon-button" onClick={() => setInspectorSurface('workspace-files')} title="打开受控工作区文件窗口；目录、导入与预览不进入对话。" type="button">▤</button>
              <button aria-label="打开终端与编码窗口" className="titlebar-icon-button" onClick={() => setInspectorSurface('terminal-coding')} title="打开审批式终端与编码窗口；不会直接执行自由命令。" type="button">›_</button>
              <button aria-label="打开项目产物检查器" className="titlebar-icon-button" onClick={() => setInspectorSurface('artifacts')} title="打开当前任务的项目产物检查器；只显示受控文件投影。" type="button">▧</button>
              <button aria-label="打开 Companion 独立窗口" className="titlebar-icon-button" onClick={() => setInspectorSurface('companion')} title="打开独立 Companion 角色窗口；不会切换模型或授予权限。" type="button">◉</button>
            </div>
            {activePage !== 'models' && <button className="gateway-attach-button attached" type="button" onClick={() => setActivePage('models')}>管理 API 连接</button>}
            {isTaskPage && <><div className="profile-switcher" aria-label={messages.profile.selectAria}>
              {WORKBENCH_PROFILE_IDS.map((profileId) => (
                <button
                  className={`agent-chip${activeProfile === profileId ? ' active' : ''}`}
                  key={profileId}
                  onClick={() => setActiveProfile(profileId)}
                  title={profiles[profileId].description}
                  type="button"
                >
                  {profiles[profileId].label}
                </button>
              ))}
            </div>
            <span className="context-chip">{snapshot?.stats ? messages.task.concurrencyPeak(snapshot.stats.maxObservedConcurrency) : messages.common.localFirst}</span>
            <span className={`status-chip ${snapshot?.status ?? ''}`}><span className="status-dot" />{statusLabel(snapshot?.status, messages)}</span></>}
          </div>
        </header>
        <section className="conversation-scroll" aria-label={messages.task.eventStreamAria}>
          <div className="conversation-frame">
            {workbenchSurface === 'chat-home' && <ChatHome activeProfile={activeProfile} authorityMode={authorityMode} connectedProviderCount={providerControl.connections?.length ?? 0} gatewayAttached={providerControl.connections.length > 0} taskModelLabel={taskModelLabel} restoringProviderSession={providerControl.restoring} draftActive={Boolean(draft.trim())} directError={directSetupError ?? directConversations.error} directResponse={directConversations.activeConversation?.messages.at(-1)?.role === 'assistant' ? { output: directConversations.activeConversation.messages.at(-1)?.text ?? '', model: directConversations.activeConversation.messages.at(-1)?.model, complete: !directConversations.streaming } : undefined} messages={messages} conversations={directConversations.conversations} activeConversationId={directConversations.activeConversation?.id} onOpenModels={() => setActivePage('models')} onProfileChange={setActiveProfile} onSuggestion={useSuggestedGoal} onSelectConversation={directConversations.select} onNewConversation={() => { if (taskModelSelection) directConversations.create(taskModelSelection); }} profiles={profiles} />}
            {isProjectPage && <ProjectBoard activeTask={snapshot ? { taskId: snapshot.taskId, runId: snapshot.runId } : undefined} error={projectWorkspace.error} storageReady={true} onAttachCurrentTask={() => projectWorkspace.attachCurrentTask(snapshot ? { taskId: snapshot.taskId, runId: snapshot.runId } : undefined)} onBackToChat={() => setActivePage('workspace')} onCreate={projectWorkspace.create} onSelect={projectWorkspace.select} pending={projectWorkspace.pending} projectTasks={projectWorkspace.projectTasks} projects={projectWorkspace.projects} selectedProjectId={projectWorkspace.selectedProjectId} />}
            {isTaskPage && snapshot && <TaskPage
              activeGoal={activeGoal}
              authorityLabel={messages.authority.mode[snapshot.authorityMode ?? authorityMode].label}
              blockedNodeId={blockedNodeId}
              deliveryCount={deliveries.length}
              citationCount={workspaceArtifacts.length}
              evidenceCount={workspaceArtifacts.length}
              providerConnections={providerControl.connections ?? []}
              eventCount={events.length}
              onApproveAndResume={approveAndResume}
              onBackToChat={() => setActivePage('workspace')}
              onOpenInspector={focusTaskInspector}
              onResume={() => void taskExecution.resume()}
              pending={pending}
              profileLabel={profiles[snapshot.profileId].label}
              snapshot={snapshot}
              taskFileCount={taskFiles.length}
            >
            <div className="welcome-card">
              <div className="welcome-eyebrow">{messages.task.welcomeEyebrow}</div>
              <h1>{messages.task.welcomeTitle}</h1>
              <p>{activeGoal ?? messages.task.initialGoal}</p>
              <div className="capability-row" aria-label={messages.task.currentCapabilities}>
                <span className="capability-badge">{messages.task.eventProtocol}</span>
                <span className="capability-badge">{messages.task.leastPrivilege}</span>
                <span className="capability-badge">{messages.task.sqliteSnapshot}</span>
                <span className="capability-badge">{profile.label} Profile</span>
                <span className="capability-badge">{messages.authority.mode[authorityMode].label}</span>
              </div>
            </div>
            <section className="workspace-model-strip" aria-label="当前模型连接状态">
              <div><span>MODEL READYNESS</span><strong>{providerControl.connections.length > 0 ? '选择一个已连接模型，开始你的第一个任务' : '先连接第三方模型，再开始工作'}</strong><p>{providerControl.connections.length > 0 ? '模型连接、测试和模型选择已移动到设置；这里保留任务对话。' : '无需安装本地模型：OpenAI-compatible 和 Anthropic-compatible 均可用。'}</p></div>
              <button type="button" onClick={() => setActivePage('models')}>{providerControl.connections.length > 0 ? '管理模型' : '连接第三方 API'}</button>
            </section>
            <LocalDataFlowBoard connectedProviderCount={providerControl.connections?.length ?? 0} gatewayAttached={providerControl.connections.length > 0} onOpenModels={() => setActivePage('models')} taskFileCount={taskFiles.length} />
            <TaskStoryboard deliveryCount={deliveries.length} eventCount={events.length} onOpenInspector={focusTaskInspector} snapshot={snapshot} taskFileCount={taskFiles.length} />
            <TaskOutcomeBoard deliveries={deliveries} deliveryPending={deliveryPending} files={taskFiles} onCreateDelivery={taskExecution.requestDelivery} onOpenInspector={focusTaskInspector} />
            {serviceError && <div className="runtime-error" role="alert">{messages.common.local}: {serviceError}</div>}
            <section className="runtime-snapshot runtime-snapshot--workspace" aria-label={messages.task.snapshotAria}>
              <div><div className="snapshot-eyebrow">{messages.task.runtimeSnapshot}</div><strong>{snapshot ? statusLabel(snapshot.status, messages) : messages.task.noTask}</strong><span>{snapshot ? `${messages.task.attempt(snapshot.attempt, Object.keys(snapshot.nodeOutcomes).length)} · ${messages.authority.mode[snapshot.authorityMode ?? 'review'].label}` : messages.task.noTaskDescription}</span>{snapshot && <span className={`provenance-status${untrustedInputCount > 0 ? ' tainted' : ''}`}>{messages.task.provenance(provenance.length, untrustedInputCount)}</span>}{snapshot && untrustedInputCount > 0 && <span className="provenance-note">{messages.task.provenanceNote}</span>}</div>
              {snapshot && <div className="snapshot-actions">{snapshot.status === 'blocked' && blockedNodeId && <button className="snapshot-primary" disabled={pending} onClick={approveAndResume} type="button">{pending ? messages.common.processing : messages.task.approveAndResume(blockedNodeId)}</button>}{(snapshot.status === 'blocked' || snapshot.status === 'failed') && <button className="snapshot-secondary" disabled={pending} onClick={() => void taskExecution.resume()} type="button">{messages.task.resume}</button>}</div>}
            </section>
            <section className="event-section">
              <div className="section-heading">
                <span>{messages.task.activity}</span>
                <span className="event-count">{messages.task.eventCount(events.length)}</span>
              </div>
              <div className="event-timeline">
                {events.length === 0 && <div className="empty-events">{messages.task.noEvents}</div>}
                {events.map((nextEvent) => {
                  const presentation = eventPresentation(nextEvent, messages);
                  return (
                    <article className="event-card" key={nextEvent.eventId}>
                      <span className={`event-marker ${presentation.tone}`} aria-hidden="true" />
                      <div>
                        <div className="event-title">{presentation.title}</div>
                        <div className="event-meta">{presentation.detail}</div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
            </TaskPage>}
          </div>
        </section>
        {activePage === 'workspace' && <div className={`task-composer${composerCollapsed ? ' task-composer--collapsed' : ''}`}>
          {composerCollapsed ? <button className="composer-expand" onClick={() => setComposerCollapsed(false)} title="展开对话编辑器以输入任务。" type="button"><span aria-hidden="true">↑</span> 展开对话编辑器</button> : <>
            <ComposerAttachments attachments={composerAttachments.map((attachment) => attachment.descriptor)} onAdd={addComposerAttachments} onRemove={removeComposerAttachment} />
            <textarea
              aria-label={messages.task.goalAria}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submitIntent();
              }}
              placeholder={messages.task.goalPlaceholder}
              value={draft}
            />
            <div className="composer-footer">
              <span className="composer-hint">{messages.task.composerHint}</span>
              <div className="composer-actions">
                <label className="authority-select">
                  <span>{messages.authority.selectLabel}</span>
                  <select aria-label={messages.authority.selectAria} onChange={(event) => setAuthorityMode(event.target.value as WorkbenchAuthorityMode)} value={authorityMode}>
                    {(['plan', 'review', 'automate'] as const).map((mode) => <option key={mode} value={mode}>{messages.authority.mode[mode].label}</option>)}
                  </select>
                </label>
                <span className="composer-mode" title={messages.authority.mode[authorityMode].description}>{profile.label} · {messages.authority.mode[authorityMode].label}</span>
                <button className="composer-collapse" onClick={() => setComposerCollapsed(true)} title="一键收起对话编辑器，保留当前草稿。" type="button">收起</button>
                <button className="composer-submit" disabled={!draft.trim() || pending || directConversations.streaming || providerControl.restoring} onClick={() => void submitIntent()} type="button">
                  {pending || directConversations.streaming || providerControl.restoring ? messages.task.submitting : messages.task.submit}
                </button>
              </div>
            </div>
          </>}
        </div>}
      </main>
      {activePage === 'workspace' && <HomeFloatingCompanion desktopCompanionAvailable={companionStudioPreferences.desktopResidencyMode === 'windows-native' && typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)} preferences={companionPreferences} presentation={floatingCompanionPreferences} onOpenDesktopCompanion={openDesktopCompanion} onOpenSettings={() => setActivePage('companion')} onPresentationChange={updateFloatingCompanion} />}
      {isSettings && <SettingsOverlay onClose={() => setActivePage('workspace')} title={pageTitle[activePage]}>{settingsContent}</SettingsOverlay>}
      {inspectorSurface === 'workspace-files' && <WorkbenchOverlay description="独立工作区文件窗口。目录、导入和预览只在你明确操作时发生；不会扫描、上传或执行文件。" onClose={() => setInspectorSurface(undefined)} title="工作区与文件" tone="api"><WorkspaceFilesPage preferences={workspaceFilePreferences} onChange={updateWorkspaceFiles} /></WorkbenchOverlay>}
      {inspectorSurface === 'terminal-coding' && <WorkbenchOverlay description="独立终端与编码窗口。只创建固定模板的待审批计划，不直接执行系统命令。" onClose={() => setInspectorSurface(undefined)} title="终端与编码" tone="api"><TerminalCodingPage workspace={workspaceFilePreferences} /></WorkbenchOverlay>}
      {inspectorSurface === 'artifacts' && <WorkbenchOverlay description="当前 task/run 的受控文件检查器。可查看 Markdown、代码、JSON、差异和用户发起的交付包，不读取任意本机目录。" onClose={() => setInspectorSurface(undefined)} title="项目产物" tone="artifacts"><PreviewPanel gatewayAttached={gatewayAttached} taskId={snapshot?.taskId} runId={snapshot?.runId} files={taskFiles} deliveries={deliveries} onFilePreview={taskExecution.loadFilePreview} onFileDiff={taskExecution.loadFileDiff} onCreateDelivery={taskExecution.createDelivery} deliveryDownloadUrl={taskExecution.deliveryDownloadUrl} /></WorkbenchOverlay>}
      {inspectorSurface === 'companion' && <WorkbenchOverlay description="独立角色窗口。角色、对话与 API 连接保持分离；高影响能力仍需未来的单独权限设计。" onClose={() => setInspectorSurface(undefined)} title="Companion" tone="companion"><CompanionWindow gatewayAttached={gatewayAttached} preferences={companionPreferences} onOpenApi={() => { setInspectorSurface(undefined); setActivePage('models'); }} onOpenControls={() => { setInspectorSurface(undefined); setActivePage('companion'); }} /></WorkbenchOverlay>}
      {isTaskPage && <PreviewPanel gatewayAttached={gatewayAttached} taskId={snapshot?.taskId} runId={snapshot?.runId} files={taskFiles} deliveries={deliveries} onFilePreview={taskExecution.loadFilePreview} onFileDiff={taskExecution.loadFileDiff} onCreateDelivery={taskExecution.createDelivery} deliveryDownloadUrl={taskExecution.deliveryDownloadUrl} />}
    </div>
  );
}
