import { useEffect, useState } from 'react';
import './components/observability/GatewayAttachment.css';
import type { AgentProfileId, TaskEvent } from '@awo/protocol';
import { Sider, type WorkbenchPage } from './components/layout/Sider';
import { ControlPlaneInsights } from './components/observability/ControlPlaneInsights';
import { ControlPlaneDiagnosticsBoard } from './components/observability/ControlPlaneDiagnosticsBoard';
import { ComponentLockBoard } from './components/observability/ComponentLockBoard';
import { ComponentManagementReceiptBoard } from './components/observability/ComponentManagementReceiptBoard';
import { ExtensionCenter } from './components/observability/ExtensionCenter';
import { LocalModelHealthBoard } from './components/observability/LocalModelHealthBoard';
import { ProviderSetupPage } from './components/settings/ProviderSetupPage';
import { NativeHostAuthenticationBoard } from './components/observability/NativeHostAuthenticationBoard';
import { WindowsNativeReleaseBoard } from './components/observability/WindowsNativeReleaseBoard';
import { SecurityPostureAuditBoard } from './components/observability/SecurityPostureAuditBoard';
import { TrajectoryBoard } from './components/observability/TrajectoryBoard';
import { PreviewPanel } from './components/preview/PreviewPanel';
import { useLocale } from './i18n/LocaleProvider';
import type { Translation } from './i18n/catalog';
import {
  HttpWorkbenchTaskClient,
  type WorkbenchAuthorityMode,
  type WorkbenchComponentLockReport,
  type WorkbenchComponentManagementReport,
  type WorkbenchControlPlaneDiagnostics,
  type WorkbenchLocalModelHealth,
  type WorkbenchProviderConnection,
  type WorkbenchProviderConnectionProbe,
  type WorkbenchProviderInference,
  type WorkbenchNativeHostAuthenticationReport,
  type WorkbenchWindowsNativeReleaseReport,
  type WorkbenchTaskSnapshot,
  type WorkbenchRunTrajectoryEvent,
  type WorkbenchSecurityPostureReport,
} from './runtime/task-client';

const localGatewayClient = HttpWorkbenchTaskClient.forLocalGateway();

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

export function App() {
  const [activePage, setActivePage] = useState<WorkbenchPage>('models');
  const [gatewayAttached, setGatewayAttached] = useState(false);
  const [gatewayAttachmentError, setGatewayAttachmentError] = useState<string>();
  const [attachingGateway, setAttachingGateway] = useState(false);
  const [events, setEvents] = useState<readonly TaskEvent[]>([]);
  const [trajectory, setTrajectory] = useState<readonly WorkbenchRunTrajectoryEvent[]>([]);
  const [localModels, setLocalModels] = useState<readonly WorkbenchLocalModelHealth[]>();
  const [localModelError, setLocalModelError] = useState<string>();
  const [providerConnections, setProviderConnections] = useState<readonly WorkbenchProviderConnection[]>();
  const [providerConnectionProbes, setProviderConnectionProbes] = useState<Readonly<Record<string, WorkbenchProviderConnectionProbe | undefined>>>({});
  const [providerInferences, setProviderInferences] = useState<Readonly<Record<string, WorkbenchProviderInference | undefined>>>({});
  const [providerConnectionError, setProviderConnectionError] = useState<string>();
  const [pendingProviderId, setPendingProviderId] = useState<string>();
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
  const [snapshot, setSnapshot] = useState<WorkbenchTaskSnapshot>();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [draft, setDraft] = useState('');
  const [activeGoal, setActiveGoal] = useState<string>();
  const [activeProfile, setActiveProfile] = useState<AgentProfileId>('build');
  const [authorityMode, setAuthorityMode] = useState<WorkbenchAuthorityMode>('review');
  const [pending, setPending] = useState(false);
  const [serviceError, setServiceError] = useState<string>();
  const { messages } = useLocale();
  const profiles = profileUi(messages);
  const profile = profiles[activeProfile];
  const pageTitle = activePage === 'workspace' ? messages.task.title : activePage === 'models' ? '模型连接' : activePage === 'operations' ? '运行记录' : '安全与系统';
  const blockedNodeId = snapshot && Object.entries(snapshot.nodeOutcomes).find(([, outcome]) => outcome === 'blocked')?.[0];
  const provenance = snapshot?.inputProvenance ?? [];
  const untrustedInputCount = provenance.filter((input) => input.trust === 'external-untrusted' || input.trust === 'derived-untrusted').length;

  useEffect(() => {
    if (!gatewayAttached) return;
    let disposed = false;
    void localGatewayClient.localModelHealth()
      .then((models) => { if (!disposed) setLocalModels(models); })
      .catch((error: unknown) => { if (!disposed) setLocalModelError(error instanceof Error ? error.message : 'Local model health unavailable'); });
    void localGatewayClient.providerConnections()
      .then((connections) => { if (!disposed) setProviderConnections(connections); })
      .catch((error: unknown) => { if (!disposed) setProviderConnectionError(error instanceof Error ? error.message : 'Provider connections unavailable'); });
    void localGatewayClient.controlPlaneDiagnostics()
      .then((report) => { if (!disposed) setControlPlaneDiagnostics(report); })
      .catch((error: unknown) => { if (!disposed) setControlPlaneDiagnosticError(error instanceof Error ? error.message : 'Control plane diagnostics unavailable'); });
    void localGatewayClient.securityPostureAudit()
      .then((report) => { if (!disposed) setSecurityPostureAudit(report); })
      .catch((error: unknown) => { if (!disposed) setSecurityPostureAuditError(error instanceof Error ? error.message : 'Security posture audit unavailable'); });
    void localGatewayClient.componentLockReport()
      .then((report) => { if (!disposed) setComponentLockReport(report); })
      .catch((error: unknown) => { if (!disposed) setComponentLockReportError(error instanceof Error ? error.message : 'Component lock report unavailable'); });
    void localGatewayClient.componentManagementReport()
      .then((report) => { if (!disposed) setComponentManagementReport(report); })
      .catch((error: unknown) => { if (!disposed) setComponentManagementReportError(error instanceof Error ? error.message : 'Component management report unavailable'); });
    void localGatewayClient.nativeHostAuthenticationReport()
      .then((report) => { if (!disposed) setNativeHostAuthenticationReport(report); })
      .catch((error: unknown) => { if (!disposed) setNativeHostAuthenticationReportError(error instanceof Error ? error.message : 'Native host authentication report unavailable'); });
    void localGatewayClient.windowsNativeReleaseReport()
      .then((report) => { if (!disposed) setWindowsNativeReleaseReport(report); })
      .catch((error: unknown) => { if (!disposed) setWindowsNativeReleaseReportError(error instanceof Error ? error.message : 'Windows native release report unavailable'); });
    return () => { disposed = true; };
  }, [gatewayAttached]);

  const gatewayErrorText = (error: unknown): string => {
    const message = error instanceof Error ? error.message : '';
    if (/Failed to fetch|DOCTYPE|JSON/.test(message)) return '本机 Gateway 未启动或无法访问。请先启动本机服务后点击重试；不会自动启动任何进程。';
    return message || '本机 Gateway 未响应。请检查服务状态后重试。';
  };

  const attachGateway = (): void => {
    if (attachingGateway || gatewayAttached) return;
    setAttachingGateway(true);
    setGatewayAttachmentError(undefined);
    void localGatewayClient.providerConnections()
      .then(() => setGatewayAttached(true))
      .catch((error: unknown) => setGatewayAttachmentError(gatewayErrorText(error)))
      .finally(() => setAttachingGateway(false));
  };

  const detachGateway = (): void => {
    setGatewayAttached(false);
    setGatewayAttachmentError(undefined);
    setProviderConnections(undefined);
    setProviderConnectionProbes({});
    setProviderInferences({});
    setLocalModels(undefined);
    setControlPlaneDiagnostics(undefined);
    setSecurityPostureAudit(undefined);
    setComponentLockReport(undefined);
    setComponentManagementReport(undefined);
    setNativeHostAuthenticationReport(undefined);
    setWindowsNativeReleaseReport(undefined);
  };

  const refreshProviderConnections = (): void => {
    if (!gatewayAttached) {
      setProviderConnectionError('请先显式附着本机 Gateway。');
      return;
    }
    setProviderConnectionError(undefined);
    void localGatewayClient.providerConnections()
      .then((connections) => setProviderConnections(connections))
      .catch((error: unknown) => setProviderConnectionError(error instanceof Error ? error.message : 'Provider connections unavailable'));
  };

  const configureProviderSession = (providerId: string, input: { displayName?: string; model?: string; apiKey: string }): void => {
    if (!gatewayAttached) {
      setProviderConnectionError('请先附着本机 Gateway，再保存模型连接。');
      return;
    }
    setPendingProviderId(providerId);
    setProviderConnectionError(undefined);
    void localGatewayClient.configureProviderSession(providerId, input)
      .then((connection) => setProviderConnections((current) => {
        const rest = (current ?? []).filter((item) => item.providerId !== providerId);
        return [...rest, connection].sort((left, right) => left.displayName.localeCompare(right.displayName));
      }))
      .catch((error: unknown) => setProviderConnectionError(gatewayErrorText(error)))
      .finally(() => setPendingProviderId(undefined));
  };

  const registerProviderConnection = (providerId: string): void => {
    if (!gatewayAttached) {
      setProviderConnectionError('请先显式附着本机 Gateway。');
      return;
    }
    setPendingProviderId(providerId);
    setProviderConnectionError(undefined);
    void localGatewayClient.registerProviderConnection(providerId, 'desktop-owner', 'Workbench explicit registration.')
      .then((connection) => { setProviderConnections((current) => (current ?? []).map((item) => item.providerId === providerId ? connection : item)); })
      .catch((error: unknown) => setProviderConnectionError(error instanceof Error ? error.message : 'Provider registration failed'))
      .finally(() => setPendingProviderId(undefined));
  };

  const activateProviderConnection = (providerId: string): void => {
    if (!gatewayAttached) {
      setProviderConnectionError('请先显式附着本机 Gateway。');
      return;
    }
    setPendingProviderId(providerId);
    setProviderConnectionError(undefined);
    void localGatewayClient.activateProviderConnection(providerId, 'desktop-owner', 'Workbench explicit activation; no automatic model call.')
      .then((connection) => { setProviderConnections((current) => (current ?? []).map((item) => item.providerId === providerId ? connection : item)); })
      .catch((error: unknown) => setProviderConnectionError(error instanceof Error ? error.message : 'Provider activation failed'))
      .finally(() => setPendingProviderId(undefined));
  };

  const probeProviderConnection = (providerId: string): void => {
    if (!gatewayAttached) {
      setProviderConnectionError('请先显式附着本机 Gateway。');
      return;
    }
    setPendingProviderId(providerId);
    setProviderConnectionError(undefined);
    void localGatewayClient.probeProviderConnection(providerId)
      .then((probe) => setProviderConnectionProbes((current) => ({ ...current, [providerId]: probe })))
      .catch((error: unknown) => setProviderConnectionError(error instanceof Error ? error.message : 'Provider probe failed'))
      .finally(() => setPendingProviderId(undefined));
  };

  const inferProviderConnection = (providerId: string, prompt: string, model?: string): void => {
    if (!gatewayAttached) {
      setProviderConnectionError('请先显式附着本机 Gateway。');
      return;
    }
    setPendingProviderId(providerId);
    setProviderConnectionError(undefined);
    void localGatewayClient.inferProviderConnection(providerId, prompt, model)
      .then((result) => setProviderInferences((current) => ({ ...current, [providerId]: result })))
      .catch((error: unknown) => setProviderConnectionError(error instanceof Error ? error.message : 'Provider inference failed'))
      .finally(() => setPendingProviderId(undefined));
  };

  const hydrate = async (nextSnapshot: WorkbenchTaskSnapshot): Promise<void> => {
    const [nextEvents, nextTrajectory] = await Promise.all([
      localGatewayClient.events(nextSnapshot.taskId, nextSnapshot.runId),
      localGatewayClient.trajectory(nextSnapshot.taskId, nextSnapshot.runId),
    ]);
    setSnapshot(nextSnapshot);
    setEvents(nextEvents);
    setTrajectory(nextTrajectory);
  };

  const submitIntent = async (): Promise<void> => {
    const goal = draft.trim();
    if (!goal || pending) return;
    if (!gatewayAttached) {
      setServiceError('请先显式附着本机 Gateway；桌面应用不会自动启动或连接服务。');
      return;
    }
    setPending(true);
    setServiceError(undefined);
    try {
      const nextSnapshot = await localGatewayClient.submit({ goal, profileId: activeProfile, authorityMode });
      await hydrate(nextSnapshot);
      setActiveGoal(goal);
      setDraft('');
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : messages.task.error.connect);
    } finally {
      setPending(false);
    }
  };

  const resume = async (): Promise<void> => {
    if (!snapshot || pending) return;
    setPending(true);
    setServiceError(undefined);
    try {
      await hydrate(await localGatewayClient.resume(snapshot.taskId, snapshot.runId));
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : messages.task.error.resume);
    } finally {
      setPending(false);
    }
  };

  const approveAndResume = async (): Promise<void> => {
    if (!snapshot || !blockedNodeId || pending) return;
    setPending(true);
    setServiceError(undefined);
    try {
      await hydrate(await localGatewayClient.approve(snapshot.taskId, snapshot.runId, blockedNodeId));
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : messages.task.error.approve);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={`workbench-shell ${activePage === 'workspace' ? 'with-preview' : 'focus-page'} theme-${theme}`}>
      <Sider
        activePage={activePage}
        onNavigate={setActivePage}
        onNewTask={() => { setActivePage('workspace'); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(`[aria-label="${messages.task.goalAria}"]`)?.focus(), 0); }}
        onThemeToggle={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
        theme={theme}
      />
      <main className="workbench-main">
        <header className="workbench-titlebar">
          <div>
            <div className="titlebar-kicker">AI WORK OS · LOCAL-FIRST</div>
            <div className="titlebar-title">{pageTitle}</div>
          </div>
          <div className="titlebar-actions">
            <button className={`gateway-attach-button${gatewayAttached ? ' attached' : ''}`} type="button" onClick={gatewayAttached ? detachGateway : attachGateway} disabled={attachingGateway}>
              {attachingGateway ? '正在附着…' : gatewayAttached ? '断开本机 Gateway' : '附着本机 Gateway'}
            </button>
            {activePage === 'workspace' && <><div className="profile-switcher" aria-label={messages.profile.selectAria}>
              {(Object.keys(profiles) as AgentProfileId[]).map((profileId) => (
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
            {activePage === 'workspace' && <>
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
            <section className={`gateway-attach-card${gatewayAttached ? ' attached' : ''}`} aria-label="Local Gateway attachment">
              <div><span>LOCAL GATEWAY</span><strong>{gatewayAttached ? '已显式附着到 127.0.0.1:4318' : '尚未附着本机 Gateway'}</strong><p>{gatewayAttached ? '已建立仅回环的 Workbench 数据通道；不会启动 Gateway、native helper 或信任桥。' : '启动后的默认状态。请先在本机单独启动 Gateway，再点击“附着本机 Gateway”。'}</p></div>
              {!gatewayAttached && <button type="button" onClick={attachGateway} disabled={attachingGateway}>{attachingGateway ? '正在检查…' : '检查并附着'}</button>}
            </section>
            {gatewayAttachmentError && <div className="runtime-error" role="alert">本机 Gateway：{gatewayAttachmentError}</div>}
            {serviceError && <div className="runtime-error" role="alert">{messages.common.local}: {serviceError}</div>}
            <section className="runtime-snapshot" aria-label={messages.task.snapshotAria}>
              <div>
                <div className="snapshot-eyebrow">{messages.task.runtimeSnapshot}</div>
                <strong>{snapshot ? statusLabel(snapshot.status, messages) : messages.task.noTask}</strong>
                <span>{snapshot ? `${messages.task.attempt(snapshot.attempt, Object.keys(snapshot.nodeOutcomes).length)} · ${messages.authority.mode[snapshot.authorityMode ?? 'review'].label}` : messages.task.noTaskDescription}</span>
                {snapshot && <span className={`provenance-status${untrustedInputCount > 0 ? ' tainted' : ''}`}>{messages.task.provenance(provenance.length, untrustedInputCount)}</span>}
                {snapshot && untrustedInputCount > 0 && <span className="provenance-note">{messages.task.provenanceNote}</span>}
              </div>
              {snapshot && (
                <div className="snapshot-actions">
                  {snapshot.status === 'blocked' && blockedNodeId && (
                    <button className="snapshot-primary" disabled={pending} onClick={approveAndResume} type="button">
                      {pending ? messages.common.processing : messages.task.approveAndResume(blockedNodeId)}
                    </button>
                  )}
                  {(snapshot.status === 'blocked' || snapshot.status === 'failed') && (
                    <button className="snapshot-secondary" disabled={pending} onClick={resume} type="button">
                      {messages.task.resume}
                    </button>
                  )}
                </div>
              )}
            </section>
            <ControlPlaneInsights events={events} snapshot={snapshot} />
            </>}
            {activePage === 'models' && <ProviderSetupPage
              gatewayAttached={gatewayAttached}
              attachingGateway={attachingGateway}
              gatewayError={gatewayAttachmentError}
              connections={gatewayAttached ? providerConnections : []}
              probes={providerConnectionProbes}
              inferences={providerInferences}
              error={providerConnectionError}
              pendingProviderId={pendingProviderId}
              onAttach={attachGateway}
              onDetach={detachGateway}
              onConfigure={configureProviderSession}
              onRefresh={refreshProviderConnections}
              onRegister={registerProviderConnection}
              onActivate={activateProviderConnection}
              onProbe={probeProviderConnection}
              onInfer={inferProviderConnection}
            />}
            {activePage === 'operations' && <section className="page-stack"><div className="page-heading"><span>RUN RECORDS</span><h1>运行记录与控制面</h1><p>这些内容只读、按需加载，不再占用任务工作区。</p></div><TrajectoryBoard events={trajectory} messages={messages} /><ControlPlaneDiagnosticsBoard error={controlPlaneDiagnosticError} messages={messages} report={controlPlaneDiagnostics} /><LocalModelHealthBoard error={localModelError} messages={messages} models={localModels} /><ExtensionCenter taskId={snapshot?.taskId} runId={snapshot?.runId} /></section>}
            {activePage === 'security' && <section className="page-stack"><div className="page-heading"><span>SECURITY & SYSTEM</span><h1>安全与系统</h1><p>所有项目均为只读证据与审计摘要；此页不能自动修复、信任或执行。</p></div><SecurityPostureAuditBoard error={securityPostureAuditError} messages={messages} report={securityPostureAudit} /><ComponentLockBoard error={componentLockReportError} messages={messages} report={componentLockReport} /><ComponentManagementReceiptBoard error={componentManagementReportError} messages={messages} report={componentManagementReport} /><NativeHostAuthenticationBoard error={nativeHostAuthenticationReportError} messages={messages} report={nativeHostAuthenticationReport} /><WindowsNativeReleaseBoard error={windowsNativeReleaseReportError} messages={messages} report={windowsNativeReleaseReport} /></section>}
            {activePage === 'workspace' && <section className="event-section">
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
            </section>}
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
      {activePage === 'workspace' && <PreviewPanel />}
    </div>
  );
}
