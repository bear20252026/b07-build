import type { Translation } from '../../i18n/catalog';
import type { WorkbenchWindowsNativeReleaseReport } from '../../runtime/task-client';

interface WindowsNativeReleaseBoardProps {
  report?: WorkbenchWindowsNativeReleaseReport;
  error?: string;
  messages: Translation;
}

function formatTimestamp(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

/** P6.5 Windows-only 冷路径视图；不含 digest、path、certificate、signature、release gate 或任何 bridge mutation 控件。 */
export function WindowsNativeReleaseBoard({ report, error, messages }: WindowsNativeReleaseBoardProps) {
  const copy = messages.windowsRelease;
  const statusLabel = { valid: copy.valid, 'not-signed': copy.notSigned, invalid: copy.invalid, unknown: copy.unknown } as const;
  if (!report) {
    return (
      <section className="windows-release-board" aria-label={copy.aria}>
        <div className="windows-release-heading"><div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div></div>
        <p className="windows-release-empty">{error ?? copy.loading}</p>
      </section>
    );
  }
  return (
    <section className="windows-release-board" aria-label={copy.aria}>
      <div className="windows-release-heading">
        <div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div>
        <span className="windows-release-count">{copy.count(report.evidences.length)}</span>
      </div>
      <p className="windows-release-meta">{copy.generatedAt}: {formatTimestamp(report.generatedAt, messages.localeName === '中文' ? 'zh-CN' : 'en-US')}</p>
      {report.evidences.length === 0 ? <p className="windows-release-empty">{copy.empty}</p> : (
        <div className="windows-release-evidences">
          {report.evidences.map((evidence) => (
            <article className={`windows-release-evidence ${evidence.authenticodeStatus}`} key={evidence.evidenceId}>
              <div><span className="windows-release-status">{statusLabel[evidence.authenticodeStatus]}</span><code>{evidence.architecture}</code></div>
              <strong>{evidence.issuerId} · {evidence.bridgeId}</strong>
              <small>{evidence.helperId} · {evidence.protocolVersion}</small>
              <small>{formatTimestamp(evidence.capturedAt, messages.localeName === '中文' ? 'zh-CN' : 'en-US')}</small>
            </article>
          ))}
        </div>
      )}
      <p className="windows-release-note">{copy.note}</p>
      <p className="windows-release-boundary">{copy.browserDenied}</p>
    </section>
  );
}
