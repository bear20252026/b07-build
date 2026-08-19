import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from '../../i18n/LocaleProvider';
import {
  HttpWorkbenchExtensionClient,
  type WorkbenchExtensionControlState,
  type WorkbenchExtensionDecision,
  type WorkbenchExtensionStatus,
} from '../../runtime/extension-client';

const extensionClient = new HttpWorkbenchExtensionClient();

type ExtensionCenterProps = Readonly<{ taskId?: string; runId?: string }>;

function extensionStatusClass(status: string): string {
  return status.replace(/[^a-z-]/gu, '');
}

export function ExtensionCenter({ taskId, runId }: ExtensionCenterProps) {
  const { messages } = useLocale();
  const [state, setState] = useState<WorkbenchExtensionControlState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setState(await extensionClient.overview(taskId, runId));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : messages.common.local);
    } finally {
      setLoading(false);
    }
  }, [messages.common.local, runId, taskId]);

  useEffect(() => { void reload(); }, [reload]);

  const installed = useMemo(() => state?.extensions.filter((extension) => extension.status === 'installed').length ?? 0, [state]);
  const latestPlan = state?.plans.at(-1);
  const statusLabel = (status: WorkbenchExtensionStatus | 'registered' | 'active') => messages.extensionCenter.status[status];
  const decisionLabel = (decision: WorkbenchExtensionDecision) => messages.extensionCenter.decision[decision];

  return (
    <section className="extension-center" aria-label={messages.extensionCenter.aria}>
      <header className="extension-center-heading">
        <div>
          <div className="extension-center-eyebrow">{messages.extensionCenter.eyebrow}</div>
          <h2>{messages.extensionCenter.title}</h2>
        </div>
        <button className="extension-refresh" disabled={loading} onClick={() => void reload()} type="button">
          {messages.extensionCenter.refresh}
        </button>
      </header>
      {loading && !state && <p className="extension-center-empty">{messages.extensionCenter.loading}</p>}
      {error && <p className="extension-center-error" role="alert">{messages.common.local}: {error}</p>}
      {state && (
        <>
          <div className="extension-center-summary">
            <strong>{messages.extensionCenter.summary(installed, state.extensions.length)}</strong>
            <span>{messages.extensionCenter.note}</span>
          </div>

          <section className="extension-center-section">
            <div className="extension-center-section-title">{messages.extensionCenter.extensions}</div>
            {state.extensions.length === 0 && <p className="extension-center-empty">{messages.extensionCenter.empty}</p>}
            <div className="extension-card-list">
              {state.extensions.map((extension) => (
                <article className="extension-card" key={extension.id}>
                  <div className="extension-card-heading">
                    <div>
                      <strong>{extension.displayName}</strong>
                      <span>{extension.id} · v{extension.version} · r{extension.revision}</span>
                    </div>
                    <span className={`extension-status ${extensionStatusClass(extension.status)}`}>{statusLabel(extension.status)}</span>
                  </div>
                  <dl className="extension-facts">
                    <div><dt>{messages.extensionCenter.source}</dt><dd>{extension.source.type} · {extension.source.digest.slice(0, 12)}</dd></div>
                    <div><dt>{messages.extensionCenter.boundary}</dt><dd>{extension.dataBoundary}</dd></div>
                    <div><dt>{messages.extensionCenter.declared}</dt><dd>{extension.declaredCapabilities.join(', ') || '—'}</dd></div>
                    <div><dt>{messages.extensionCenter.requested}</dt><dd>{extension.requestedPermissions.join(', ') || '—'}</dd></div>
                    <div><dt>{messages.extensionCenter.budget}</dt><dd>{extension.resourceBudget.maxMemoryMb} MB · {extension.resourceBudget.maxCpuMs} ms</dd></div>
                    <div><dt>{messages.extensionCenter.entry}</dt><dd>{extension.entry ? extension.entry.mode : '—'}</dd></div>
                  </dl>
                  {extension.note && <p className="extension-card-note">{extension.note}</p>}
                </article>
              ))}
            </div>
          </section>

          <section className="extension-center-section">
            <div className="extension-center-section-title">{messages.extensionCenter.diagnostics}</div>
            {state.diagnostics.length === 0 && <p className="extension-center-empty">{messages.extensionCenter.noDiagnostics}</p>}
            <div className="extension-diagnostic-list">
              {state.diagnostics.map((diagnostic) => (
                <article className={`extension-diagnostic ${diagnostic.severity}`} key={`${diagnostic.extensionId}:${diagnostic.revision}:${diagnostic.code}`}>
                  <strong>{diagnostic.extensionId} · {diagnostic.code}</strong>
                  <span>{diagnostic.message}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="extension-center-section">
            <div className="extension-center-section-title">{messages.extensionCenter.profiles}</div>
            {state.providerProfiles.length === 0 && <p className="extension-center-empty">{messages.extensionCenter.noProfiles}</p>}
            <div className="provider-profile-list">
              {state.providerProfiles.map((profile) => (
                <article className="provider-profile-card" key={profile.id}>
                  <div className="extension-card-heading">
                    <div><strong>{profile.displayName}</strong><span>{profile.id} · r{profile.revision}</span></div>
                    <span className={`extension-status ${extensionStatusClass(profile.status)}`}>{statusLabel(profile.status)}</span>
                  </div>
                  <dl className="extension-facts">
                    <div><dt>{messages.extensionCenter.drivers}</dt><dd>{profile.driverIds.join(', ')}</dd></div>
                    <div><dt>{messages.extensionCenter.boundary}</dt><dd>{profile.maximumDataBoundary}</dd></div>
                    <div><dt>{messages.extensionCenter.credentialRef}</dt><dd>{profile.credentialReference ?? '—'}</dd></div>
                    <div><dt>{messages.extensionCenter.reviewer}</dt><dd>{profile.reviewedBy}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <section className="extension-center-section">
            <div className="extension-center-section-title">{messages.extensionCenter.plans}</div>
            {!latestPlan && <p className="extension-center-empty">{messages.extensionCenter.noPlans}</p>}
            {latestPlan && (
              <article className="extension-plan-card">
                <div className="extension-card-heading">
                  <div><strong>{latestPlan.planId}</strong><span>{latestPlan.taskId} · {latestPlan.runId}</span></div>
                  <span className={`extension-status ${latestPlan.outcome}`}>{latestPlan.outcome === 'ready' ? messages.extensionCenter.planReady : messages.extensionCenter.planBlocked}</span>
                </div>
                <div className="extension-plan-entries">
                  {latestPlan.entries.map((entry) => (
                    <div className="extension-plan-entry" key={`${entry.extensionId}:${entry.revision}`}>
                      <div><strong>{entry.extensionId}</strong><span>{entry.kind} · r{entry.revision}</span></div>
                      <span className={`extension-decision ${entry.decision}`}>{decisionLabel(entry.decision)}</span>
                      {entry.reasons.map((reason) => <p key={reason.code}>{reason.code}: {reason.detail}</p>)}
                    </div>
                  ))}
                </div>
                <p className="extension-plan-note">{messages.extensionCenter.canExecute}</p>
              </article>
            )}
          </section>
        </>
      )}
    </section>
  );
}
