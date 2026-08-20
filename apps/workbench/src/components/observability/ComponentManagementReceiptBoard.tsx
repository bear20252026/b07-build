import type { Translation } from '../../i18n/catalog';
import type { WorkbenchComponentManagementReport } from '../../runtime/task-client';

interface ComponentManagementReceiptBoardProps {
  report?: WorkbenchComponentManagementReport;
  error?: string;
  messages: Translation;
}

function formatTimestamp(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

/** P6.3 受控宿主操作的只读审计投影；浏览器不拥有任何构件管理、签发或修复控件。 */
export function ComponentManagementReceiptBoard({ report, error, messages }: ComponentManagementReceiptBoardProps) {
  const copy = messages.componentManagement;
  if (!report) {
    return (
      <section className="component-management-board" aria-label={copy.aria}>
        <div className="component-management-heading"><div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div></div>
        <p className="component-management-empty">{error ?? copy.loading}</p>
      </section>
    );
  }
  return (
    <section className="component-management-board" aria-label={copy.aria}>
      <div className="component-management-heading">
        <div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div>
        <span className="component-management-count">{copy.count(report.receipts.length)}</span>
      </div>
      <p className="component-management-meta">{copy.generatedAt}: {formatTimestamp(report.generatedAt, messages.localeName === '中文' ? 'zh-CN' : 'en-US')}</p>
      {report.receipts.length === 0 ? <p className="component-management-empty">{copy.empty}</p> : (
        <div className="component-management-receipts">
          {report.receipts.map((receipt) => (
            <article className={`component-management-receipt ${receipt.outcome}`} key={receipt.operationId}>
              <div><span className="component-management-status">{receipt.outcome === 'applied' ? copy.applied : copy.rejected}</span><code>{receipt.action}</code></div>
              <strong>{receipt.componentId}</strong>
              <small>{receipt.issuerId} · {formatTimestamp(receipt.recordedAt, messages.localeName === '中文' ? 'zh-CN' : 'en-US')}{receipt.rejectionCode ? ` · ${receipt.rejectionCode}` : ''}</small>
            </article>
          ))}
        </div>
      )}
      <p className="component-management-note">{copy.note}</p>
      <p className="component-management-boundary">{copy.browserDenied}</p>
    </section>
  );
}
