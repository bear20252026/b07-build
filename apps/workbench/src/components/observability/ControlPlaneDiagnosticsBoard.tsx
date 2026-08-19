import type { Translation } from '../../i18n/catalog';
import type { WorkbenchControlPlaneDiagnostics } from '../../runtime/task-client';

interface ControlPlaneDiagnosticsBoardProps {
  report?: WorkbenchControlPlaneDiagnostics;
  error?: string;
  messages: Translation;
}

export function ControlPlaneDiagnosticsBoard({ report, error, messages }: ControlPlaneDiagnosticsBoardProps) {
  const copy = messages.diagnostics;
  if (!report) {
    return (
      <section className="control-diagnostics-board" aria-label={copy.aria}>
        <div className="diagnostics-heading"><div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div></div>
        <p className="diagnostics-empty">{error ?? copy.loading}</p>
      </section>
    );
  }
  const findingCount = report.extensions.reduce((total, extension) => total + extension.findings.length, 0);
  const registeredCount = report.extensions.length + report.skillPacks.length + report.providers.length + report.trustedDesktopIssuers.length;
  return (
    <section className="control-diagnostics-board" aria-label={copy.aria}>
      <div className="diagnostics-heading">
        <div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div>
        <span className="diagnostics-count">{registeredCount}</span>
      </div>
      {registeredCount === 0 && report.localModels.length === 0 ? <p className="diagnostics-empty">{copy.empty}</p> : (
        <div className="diagnostics-grid">
          <article><span>{copy.extensions}</span><strong>{report.extensions.length}</strong><small>{copy.findings(findingCount)}</small></article>
          <article><span>{copy.skillPacks}</span><strong>{report.skillPacks.length}</strong><small>{report.skillPacks.reduce((total, pack) => total + pack.estimatedTokens, 0)} tokens</small></article>
          <article><span>{copy.providers}</span><strong>{report.providers.length}</strong><small>{report.providers.filter((provider) => provider.status === 'active').length} active</small></article>
          <article><span>{copy.localModels}</span><strong>{report.localModels.length}</strong><small>{report.localModels.filter((model) => model.healthStatus === 'healthy').length} healthy</small></article>
          <article><span>{copy.trustedIssuers}</span><strong>{report.trustedDesktopIssuers.length}</strong><small>{copy.issuerCount(report.trustedDesktopIssuers.length)}</small></article>
        </div>
      )}
      <p className="diagnostics-authority">{copy.issuerRequired}</p>
      <p className="diagnostics-note">{copy.note}</p>
    </section>
  );
}
