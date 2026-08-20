import type { Translation } from '../../i18n/catalog';
import type { WorkbenchNativeHostAuthenticationReport } from '../../runtime/task-client';

interface NativeHostAuthenticationBoardProps {
  report?: WorkbenchNativeHostAuthenticationReport;
  error?: string;
  messages: Translation;
}

function formatTimestamp(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

/** P6.4 认证桥只读投影；故意不含 origin、公钥、nonce、签名、challenge、attestation 或 mutation 控件。 */
export function NativeHostAuthenticationBoard({ report, error, messages }: NativeHostAuthenticationBoardProps) {
  const copy = messages.nativeHostAuthentication;
  if (!report) {
    return (
      <section className="native-host-auth-board" aria-label={copy.aria}>
        <div className="native-host-auth-heading"><div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div></div>
        <p className="native-host-auth-empty">{error ?? copy.loading}</p>
      </section>
    );
  }
  return (
    <section className="native-host-auth-board" aria-label={copy.aria}>
      <div className="native-host-auth-heading">
        <div><span>{copy.eyebrow}</span><h2>{copy.title}</h2></div>
        <span className="native-host-auth-count">{copy.count(report.bridges.length)}</span>
      </div>
      <p className="native-host-auth-meta">{copy.generatedAt}: {formatTimestamp(report.generatedAt, messages.localeName === '中文' ? 'zh-CN' : 'en-US')}</p>
      <div className="native-host-auth-summary">
        <span>{copy.nonce.issued}: {report.challengeSummary.issued}</span>
        <span>{copy.nonce.verified}: {report.challengeSummary.consumedVerified}</span>
        <span>{copy.nonce.rejected}: {report.challengeSummary.consumedRejected}</span>
      </div>
      {report.bridges.length === 0 ? <p className="native-host-auth-empty">{copy.empty}</p> : (
        <div className="native-host-auth-bridges">
          {report.bridges.map((bridge) => (
            <article className={`native-host-auth-bridge ${bridge.status}`} key={`${bridge.issuerId}:${bridge.bridgeId}`}>
              <div><span className="native-host-auth-status">{copy[bridge.status]}</span><code>{bridge.transport}</code></div>
              <strong>{bridge.issuerId} · {bridge.bridgeId}</strong>
              <small>{bridge.allowedActions.join(', ')}</small>
            </article>
          ))}
        </div>
      )}
      <p className="native-host-auth-note">{copy.note}</p>
      <p className="native-host-auth-boundary">{copy.browserDenied}</p>
    </section>
  );
}
