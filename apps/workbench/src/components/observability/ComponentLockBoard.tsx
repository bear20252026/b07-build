import type { Translation } from '../../i18n/catalog';
import type { WorkbenchComponentLockReport } from '../../runtime/task-client';

interface ComponentLockBoardProps {
  report?: WorkbenchComponentLockReport;
  error?: string;
  messages: Translation;
}

function formatInspectionTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

/** P6.2 只读构件 lock 投影；此组件不含登记、审批、修复、加载或激活控件。 */
export function ComponentLockBoard({ report, error, messages }: ComponentLockBoardProps) {
  const copy = messages.componentLock;
  if (!report) {
    return (
      <section className="component-lock-board" aria-label={copy.aria}>
        <div className="component-lock-heading"><div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div></div>
        <p className="component-lock-empty">{error ?? copy.loading}</p>
      </section>
    );
  }
  return (
    <section className="component-lock-board" aria-label={copy.aria}>
      <div className="component-lock-heading">
        <div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div>
        <span className="component-lock-count">{copy.decisions(report.decisions.length)}</span>
      </div>
      <p className="component-lock-meta">{report.lockfile ? copy.locked(report.lockfile.revision) : copy.unlocked}</p>
      <p className="component-lock-meta">{copy.inspectedAt}: {formatInspectionTime(report.inspectedAt, messages.localeName === '中文' ? 'zh-CN' : 'en-US')}</p>
      {report.decisions.length === 0 ? <p className="component-lock-empty">{copy.empty}</p> : (
        <div className="component-lock-decisions">
          {report.decisions.map((decision) => (
            <article className={`component-lock-decision ${decision.eligibility}`} key={decision.componentId}>
              <div><span className="component-lock-status">{decision.eligibility === 'eligible' ? copy.eligible : copy.quarantined}</span><code>{decision.componentKind}</code></div>
              <strong>{decision.componentId}</strong>
              {decision.reasons.length > 0 && <small>{copy.reasons}: {decision.reasons.join(', ')}</small>}
            </article>
          ))}
        </div>
      )}
      <p className="component-lock-note">{copy.note}</p>
      <p className="component-lock-boundary">{copy.cannotRepair}</p>
    </section>
  );
}
