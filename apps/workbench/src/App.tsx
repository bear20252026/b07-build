import { useEffect, useState } from 'react';
import './components/observability/GatewayAttachment.css';
import { invoke } from '@tauri-apps/api/core';
import type { AgentProfileId, TaskEvent } from '@awo/protocol';
import { Sider, type WorkbenchPage } from './components/layout/Sider';
import { CommandPalette } from './components/layout/CommandPalette';
import { createWorkbenchCommandCatalog, type WorkbenchCommand } from './components/layout/command-catalog';
import { resolveWorkbenchSurface } from './components/layout/workbench-surface';
import { ControlPlaneDiagnosticsBoard } from './components/observability/ControlPlaneDiagnosticsBoard';
import { ComponentLockBoard } from './components/observability/ComponentLockBoard';
import { ComponentManagementReceiptBoard } from './components/observability/ComponentManagementReceiptBoard';
import { ExtensionCenter } from './components/observability/ExtensionCenter';
import { LocalModelHealthBoard } from './components/observability/LocalModelHealthBoard';
import { ApiUsageAuditPage, ApiUsageSummaryCard } from './components/observability/ApiUsageBoards';
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
import { WORKBENCH_PROFILE_IDS } from './components/workspace/agent-profiles';
import { LocalDataFlowBoard } from './components/workspace/LocalDataFlowBoard';
import { TaskStoryboard } from './components/workspace/TaskStoryboard';
import { TaskOutcomeBoard } from './components/workspace/TaskOutcomeBoard';
import { TaskPage } from './components/workspace/TaskPage';
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
import { useTaskExecution } from './runtime/use-task-execution';

const localGatewayClient = HttpWorkbenchTaskClient.forLocalGateway();
const localProjectClient = createProjectClient('http://127.0.0.1:4318');

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
  if (/Failed to fetch|DOCTYPE|Unexpected token|JSON/i.test(message)) return '未收到可用的 Gateway 响应。请点击“启动并附着 Gateway”，等待本机服务就绪后重试。';
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
  const [activeGoal, setActiveGoal] = useState<string>();
  const [activeProfile, setActiveProfile] = useState<AgentProfileId>('build');
  const [authorityMode, setAuthorityMode] = useState<WorkbenchAuthorityMode>('review');
  const { messages } = useLocale();
  const taskExecution = useTaskExecution(gatewayAttached, {
    gatewayRequired: '请先显式附着本机 Gateway；桌面应用不会自动启动或连接服务。',
    submitFailed: messages.task.error.connect,
    resumeFailed: messages.task.error.resume,
    approvalFailed: messages.task.error.approve,
  }, localGatewayClient);
  const { snapshot, events, trajectory, workspaceArtifacts, checkpoints, taskFiles, deliveries, pending, deliveryPending, error: serviceError } = taskExecution;
  const projectWorkspace = useProjectWorkspace(gatewayAttached, activePage, gatewayErrorText, localProjectClient);
  const providerControl = useProviderControlPlane(gatewayAttached, gatewayErrorText, localGatewayClient);
  const profiles = profileUi(messages);
  const profile = profiles[activeProfile];
  const pageTitle: Record<WorkbenchPage, string> = { workspace: messages.task.title, projects: '项目', task: '当前任务', models: '模型连接', connections: '已连接模型', operations: '运行记录', 'api-usage': 'API 使用审计', capabilities: '扩展与能力', security: '安全与系统' };
  const blockedNodeId = snapshot && Object.entries(snapshot.nodeOutcomes).find(([, outcome]) => outcome === 'blocked')?.[0];
  const provenance = snapshot?.inputProvenance ?? [];
  const untrustedInputCount = provenance.filter((input) => input.trust === 'external-untrusted' || input.trust === 'derived-untrusted').length;
  const workbenchSurface = resolveWorkbenchSurface({ activePage, hasTaskSnapshot: Boolean(snapshot) });
  const isTaskPage = workbenchSurface === 'task-page';
  const isProjectPage = workbenchSurface === 'project-page';
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

  const startAndAttachGateway = (): void => {
    if (attachingGateway || gatewayAttached) return;
    const awaitGatewayReadiness = (remainingAttempts: number): Promise<readonly WorkbenchProviderConnection[]> => localGatewayClient.providerConnections()
      .catch((error: unknown) => remainingAttempts <= 0
        ? Promise.reject(error)
        : new Promise<void>((resolve) => window.setTimeout(resolve, 250)).then(() => awaitGatewayReadiness(remainingAttempts - 1)));
    setAttachingGateway(true);
    setGatewayAttachmentError(undefined);
    void invoke<'started' | 'already-running'>('start_local_gateway')
      .then(() => awaitGatewayReadiness(8))
      .then((connections) => { providerControl.hydrateConnections(connections); setGatewayAttached(true); })
      .catch((error: unknown) => {
        setActivePage('models');
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('gateway-sidecar-unavailable')) {
          setGatewayAttachmentError('本机 Gateway 未能启动。请重新安装完整 Windows 应用后重试；不会自动启动任何其它程序。');
          return;
        }
        if (message.includes('window.__TAURI') || message.includes('IPC')) {
          setGatewayAttachmentError('此启动入口仅在 Windows 桌面应用中可用。浏览器预览需手动启动本机 Gateway。');
          return;
        }
        setGatewayAttachmentError(gatewayErrorText(error));
      })
      .finally(() => setAttachingGateway(false));
  };


  const detachGateway = (): void => {
    setGatewayAttached(false);
    setGatewayAttachmentError(undefined);
    providerControl.reset();
    setLocalModels(undefined);
    setControlPlaneDiagnostics(undefined);
    setSecurityPostureAudit(undefined);
    setComponentLockReport(undefined);
    setComponentManagementReport(undefined);
    setNativeHostAuthenticationReport(undefined);
    setWindowsNativeReleaseReport(undefined);
    taskExecution.reset();
    projectWorkspace.reset();
  };

  const submitIntent = async (): Promise<void> => {
    const goal = draft.trim();
    if (!goal) return;
    if (await taskExecution.submit(goal, activeProfile, authorityMode)) {
      setActiveGoal(goal);
      setDraft('');
      setActivePage('task');
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

  return (
    <div className={`workbench-shell ${isTaskPage ? 'with-preview' : 'focus-page'} theme-${theme}`}>
      <Sider
        activePage={activePage}
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
            <div className="titlebar-title">{pageTitle[activePage]}</div>
          </div>
          <div className="titlebar-actions">
            <CommandPalette commands={commandCatalog} onExecute={executeCommand} />
            {activePage !== 'models' && <button className={`gateway-attach-button${gatewayAttached ? ' attached' : ''}`} type="button" onClick={gatewayAttached ? detachGateway : startAndAttachGateway} disabled={attachingGateway}>
              {attachingGateway ? '正在启动并附着…' : gatewayAttached ? '断开本机 Gateway' : '启动并附着 Gateway'}
            </button>}
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
            {workbenchSurface === 'chat-home' && <ChatHome activeProfile={activeProfile} authorityMode={authorityMode} connectedProviderCount={providerControl.connections?.length ?? 0} gatewayAttached={gatewayAttached} messages={messages} onOpenModels={() => setActivePage('models')} onProfileChange={setActiveProfile} onSuggestion={useSuggestedGoal} onTemplate={(template) => { setDraft(template.goal); setActiveProfile(template.profileId); setAuthorityMode(template.authorityMode); focusTaskComposer(); }} profiles={profiles} />}
            {isProjectPage && <ProjectBoard activeTask={snapshot ? { taskId: snapshot.taskId, runId: snapshot.runId } : undefined} error={projectWorkspace.error} gatewayAttached={gatewayAttached} onAttachCurrentTask={() => projectWorkspace.attachCurrentTask(snapshot ? { taskId: snapshot.taskId, runId: snapshot.runId } : undefined)} onBackToChat={() => setActivePage('workspace')} onCreate={projectWorkspace.create} onSelect={projectWorkspace.select} pending={projectWorkspace.pending} projectTasks={projectWorkspace.projectTasks} projects={projectWorkspace.projects} selectedProjectId={projectWorkspace.selectedProjectId} />}
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
              <div><span>MODEL READYNESS</span><strong>{gatewayAttached ? '选择一个已连接模型，开始你的第一个任务' : '先连接第三方模型，再开始工作'}</strong><p>{gatewayAttached ? '模型连接、测试和高级诊断已移动到设置；这里保留任务对话。' : '无需安装本地模型：OpenAI-compatible 和 Anthropic-compatible 均可用。'}</p></div>
              <button type="button" onClick={() => setActivePage('models')}>{gatewayAttached ? '管理模型' : '连接第三方 API'}</button>
            </section>
            <LocalDataFlowBoard connectedProviderCount={providerControl.connections?.length ?? 0} gatewayAttached={gatewayAttached} onOpenModels={() => setActivePage('models')} taskFileCount={taskFiles.length} />
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
            {activePage === 'models' && <ProviderSetupPage gatewayAttached={gatewayAttached} attachingGateway={attachingGateway} gatewayError={gatewayAttachmentError} connections={gatewayAttached ? providerControl.connections : []} error={providerControl.error} pendingProviderId={providerControl.pendingProviderId} onAttach={startAndAttachGateway} onDetach={detachGateway} onConfigure={providerControl.configure} onConfigureCustom={providerControl.configureCustom} onManageConnections={() => setActivePage('connections')} />}
            {activePage === 'connections' && <section className="page-stack"><div className="page-heading"><span>CONNECTED MODELS</span><h1>已连接模型</h1><p>保存连接后，在此页查看状态、手动测试模型目录或发送一次受限文本请求；不会自动调用第三方 API。</p></div><ProviderConnectionCenter connections={gatewayAttached ? providerControl.connections : []} probes={providerControl.probes} inferences={providerControl.inferences} error={providerControl.error} pendingProviderId={providerControl.pendingProviderId} onRefresh={providerControl.refresh} onRegister={providerControl.register} onActivate={providerControl.activate} onProbe={providerControl.probe} onInfer={providerControl.infer} /></section>}
            {activePage === 'operations' && <section className="page-stack"><div className="page-heading"><span>RUN RECORDS</span><h1>运行记录</h1><p>检查点、产出账本与只读轨迹；它们可解释运行，但不能重放副作用。</p></div><ApiUsageSummaryCard gatewayAttached={gatewayAttached} onOpen={() => setActivePage('api-usage')} /><RunWorkspaceBoard artifacts={workspaceArtifacts} checkpoints={checkpoints} /><TrajectoryBoard events={trajectory} messages={messages} /></section>}
            {activePage === 'api-usage' && <ApiUsageAuditPage gatewayAttached={gatewayAttached} onBack={() => setActivePage('operations')} />}
            {activePage === 'capabilities' && <section className="page-stack"><div className="page-heading"><span>EXTENSIONS & CAPABILITIES</span><h1>扩展与能力</h1><p>按需读取扩展、本地模型与控制面摘要；此页不会启动模型、修改 Provider 或读取密钥。</p></div><KnowledgeImportPanel gatewayAttached={gatewayAttached} /><ExtensionCenter taskId={snapshot?.taskId} runId={snapshot?.runId} /><LocalModelHealthBoard error={localModelError} messages={messages} models={localModels} /><ControlPlaneDiagnosticsBoard error={controlPlaneDiagnosticError} messages={messages} report={controlPlaneDiagnostics} /></section>}
            {activePage === 'security' && <section className="page-stack"><div className="page-heading"><span>SECURITY & SYSTEM</span><h1>安全与系统</h1><p>所有项目均为只读证据与审计摘要；此页不能自动修复、信任或执行。</p></div><SecurityPostureAuditBoard error={securityPostureAuditError} messages={messages} report={securityPostureAudit} /><ComponentLockBoard error={componentLockReportError} messages={messages} report={componentLockReport} /><ComponentManagementReceiptBoard error={componentManagementReportError} messages={messages} report={componentManagementReport} /><NativeHostAuthenticationBoard error={nativeHostAuthenticationReportError} messages={messages} report={nativeHostAuthenticationReport} /><WindowsNativeReleaseBoard error={windowsNativeReleaseReportError} messages={messages} report={windowsNativeReleaseReport} /></section>}
          </div>
        </section>
        {activePage === 'workspace' && <div className="task-composer">
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
              <button className="composer-submit" disabled={!draft.trim() || pending} onClick={() => void submitIntent()} type="button">
                {pending ? messages.task.submitting : messages.task.submit}
              </button>
            </div>
          </div>
        </div>}
      </main>
      {isTaskPage && <PreviewPanel gatewayAttached={gatewayAttached} taskId={snapshot?.taskId} runId={snapshot?.runId} files={taskFiles} deliveries={deliveries} onFilePreview={taskExecution.loadFilePreview} onFileDiff={taskExecution.loadFileDiff} onCreateDelivery={taskExecution.createDelivery} deliveryDownloadUrl={taskExecution.deliveryDownloadUrl} />}
    </div>
  );
}
