import { useEffect, useState } from 'react';
import type { AgentProfileId, TaskEvent } from '@awo/protocol';
import { Sider } from './components/layout/Sider';
import { ControlPlaneInsights } from './components/observability/ControlPlaneInsights';
import { ControlPlaneDiagnosticsBoard } from './components/observability/ControlPlaneDiagnosticsBoard';
import { ComponentLockBoard } from './components/observability/ComponentLockBoard';
import { ComponentManagementReceiptBoard } from './components/observability/ComponentManagementReceiptBoard';
import { ExtensionCenter } from './components/observability/ExtensionCenter';
import { LocalModelHealthBoard } from './components/observability/LocalModelHealthBoard';
import { NativeHostAuthenticationBoard } from './components/observability/NativeHostAuthenticationBoard';
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
  type WorkbenchNativeHostAuthenticationReport,
  type WorkbenchTaskSnapshot,
  type WorkbenchRunTrajectoryEvent,
  type WorkbenchSecurityPostureReport,
} from './runtime/task-client';

const taskClient = new HttpWorkbenchTaskClient();

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
  const [events, setEvents] = useState<readonly TaskEvent[]>([]);
  const [trajectory, setTrajectory] = useState<readonly WorkbenchRunTrajectoryEvent[]>([]);
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
  const blockedNodeId = snapshot && Object.entries(snapshot.nodeOutcomes).find(([, outcome]) => outcome === 'blocked')?.[0];
  const provenance = snapshot?.inputProvenance ?? [];
  const untrustedInputCount = provenance.filter((input) => input.trust === 'external-untrusted' || input.trust === 'derived-untrusted').length;

  useEffect(() => {
    let disposed = false;
    void taskClient.localModelHealth()
      .then((models) => { if (!disposed) setLocalModels(models); })
      .catch((error: unknown) => { if (!disposed) setLocalModelError(error instanceof Error ? error.message : 'Local model health unavailable'); });
    void taskClient.controlPlaneDiagnostics()
      .then((report) => { if (!disposed) setControlPlaneDiagnostics(report); })
      .catch((error: unknown) => { if (!disposed) setControlPlaneDiagnosticError(error instanceof Error ? error.message : 'Control plane diagnostics unavailable'); });
    void taskClient.securityPostureAudit()
      .then((report) => { if (!disposed) setSecurityPostureAudit(report); })
      .catch((error: unknown) => { if (!disposed) setSecurityPostureAuditError(error instanceof Error ? error.message : 'Security posture audit unavailable'); });
    void taskClient.componentLockReport()
      .then((report) => { if (!disposed) setComponentLockReport(report); })
      .catch((error: unknown) => { if (!disposed) setComponentLockReportError(error instanceof Error ? error.message : 'Component lock report unavailable'); });
    void taskClient.componentManagementReport()
      .then((report) => { if (!disposed) setComponentManagementReport(report); })
      .catch((error: unknown) => { if (!disposed) setComponentManagementReportError(error instanceof Error ? error.message : 'Component management report unavailable'); });
    void taskClient.nativeHostAuthenticationReport()
      .then((report) => { if (!disposed) setNativeHostAuthenticationReport(report); })
      .catch((error: unknown) => { if (!disposed) setNativeHostAuthenticationReportError(error instanceof Error ? error.message : 'Native host authentication report unavailable'); });
    return () => { disposed = true; };
  }, []);

  const hydrate = async (nextSnapshot: WorkbenchTaskSnapshot): Promise<void> => {
    const [nextEvents, nextTrajectory] = await Promise.all([
      taskClient.events(nextSnapshot.taskId, nextSnapshot.runId),
      taskClient.trajectory(nextSnapshot.taskId, nextSnapshot.runId),
    ]);
    setSnapshot(nextSnapshot);
    setEvents(nextEvents);
    setTrajectory(nextTrajectory);
  };

  const submitIntent = async (): Promise<void> => {
    const goal = draft.trim();
    if (!goal || pending) return;
    setPending(true);
    setServiceError(undefined);
    try {
      const nextSnapshot = await taskClient.submit({ goal, profileId: activeProfile, authorityMode });
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
      await hydrate(await taskClient.resume(snapshot.taskId, snapshot.runId));
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
      await hydrate(await taskClient.approve(snapshot.taskId, snapshot.runId, blockedNodeId));
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : messages.task.error.approve);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={`workbench-shell theme-${theme}`}>
      <Sider
        onNewTask={() => document.querySelector<HTMLTextAreaElement>(`[aria-label="${messages.task.goalAria}"]`)?.focus()}
        onThemeToggle={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
        theme={theme}
      />
      <main className="workbench-main">
        <header className="workbench-titlebar">
          <div>
            <div className="titlebar-kicker">{messages.task.controlPlane}</div>
            <div className="titlebar-title">{messages.task.title}</div>
          </div>
          <div className="titlebar-actions">
            <div className="profile-switcher" aria-label={messages.profile.selectAria}>
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
            <span className={`status-chip ${snapshot?.status ?? ''}`}><span className="status-dot" />{statusLabel(snapshot?.status, messages)}</span>
          </div>
        </header>
        <section className="conversation-scroll" aria-label={messages.task.eventStreamAria}>
          <div className="conversation-frame">
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
            <TrajectoryBoard events={trajectory} messages={messages} />
            <ControlPlaneDiagnosticsBoard error={controlPlaneDiagnosticError} messages={messages} report={controlPlaneDiagnostics} />
            <SecurityPostureAuditBoard error={securityPostureAuditError} messages={messages} report={securityPostureAudit} />
            <ComponentLockBoard error={componentLockReportError} messages={messages} report={componentLockReport} />
            <ComponentManagementReceiptBoard error={componentManagementReportError} messages={messages} report={componentManagementReport} />
            <NativeHostAuthenticationBoard error={nativeHostAuthenticationReportError} messages={messages} report={nativeHostAuthenticationReport} />
            <LocalModelHealthBoard error={localModelError} messages={messages} models={localModels} />
            <ExtensionCenter taskId={snapshot?.taskId} runId={snapshot?.runId} />
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
          </div>
        </section>
        <div className="task-composer">
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
        </div>
      </main>
      <PreviewPanel />
    </div>
  );
}
