import type { Translation } from '../../i18n/catalog';
import type { WorkbenchSecurityPostureReport } from '../../runtime/task-client';

interface SecurityPostureAuditBoardProps {
  report?: WorkbenchSecurityPostureReport;
  error?: string;
  messages: Translation;
}

function formatAuditTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

/** 只读 Security Posture 投影；finding 只能解释既有冷路径 evidence，不能修复或扩大能力。 */
export function SecurityPostureAuditBoard({ report, error, messages }: SecurityPostureAuditBoardProps) {
  const copy = messages.securityAudit;
  if (!report) {
    return (
      <section className="security-audit-board" aria-label={copy.aria}>
        <div className="security-audit-heading"><div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div></div>
        <p className="security-audit-empty">{error ?? copy.loading}</p>
      </section>
    );
  }
  return (
    <section className="security-audit-board" aria-label={copy.aria}>
      <div className="security-audit-heading">
        <div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div>
        <span className="security-audit-count">{copy.findings(report.findings.length)}</span>
      </div>
      <p className="security-audit-time">{copy.auditedAt}: {formatAuditTime(report.auditedAt, messages.localeName === '中文' ? 'zh-CN' : 'en-US')}</p>
      {report.findings.length === 0 ? <p className="security-audit-empty">{copy.empty}</p> : (
        <div className="security-audit-findings">
          {report.findings.map((finding) => (
            <article className={`security-audit-finding ${finding.severity}`} key={`${finding.checkId}:${finding.subjectKind}:${finding.subjectId}`}>
              <div><span className="security-audit-severity">{copy.severity[finding.severity]}</span><code>{finding.checkId}</code></div>
              <strong>{finding.subjectKind} · {finding.subjectId}</strong>
              <small>{finding.remediationHint}</small>
            </article>
          ))}
        </div>
      )}
      <p className="security-audit-note">{copy.note}</p>
      <p className="security-audit-boundary">{copy.cannotRemediate}</p>
    </section>
  );
}
