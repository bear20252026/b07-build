import type { TaskEvent } from '@awo/protocol';
import { useLocale } from '../../i18n/LocaleProvider';
import type { WorkbenchTaskSnapshot } from '../../runtime/task-client';

export interface ControlPlaneInsightsProps {
  snapshot?: WorkbenchTaskSnapshot;
  events: readonly TaskEvent[];
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100)));
}

export function ControlPlaneInsights({ snapshot, events }: ControlPlaneInsightsProps) {
  const { messages } = useLocale();
  const stats = snapshot?.stats;
  const total = stats?.totalNodes ?? 0;
  const completed = stats?.completedNodes ?? 0;
  const blocked = stats?.blockedNodes ?? 0;
  const failed = stats?.failedNodes ?? 0;
  const compacted = events.filter((event) => event.type === 'context.compacted').length;
  const approvals = events.filter((event) => event.type === 'approval.required').length;
  const progress = ratio(completed + failed + blocked, total);

  const metrics = [
    { id: 'execution', label: messages.insights.execution, value: messages.insights.nodeCount(completed, total), percentage: progress, tone: 'success' },
    { id: 'concurrency', label: messages.insights.concurrency, value: messages.insights.peak(stats?.maxObservedConcurrency ?? 0), percentage: total > 0 ? ratio(stats?.maxObservedConcurrency ?? 0, total) : 0, tone: 'neutral' },
    { id: 'approval', label: messages.insights.safetyGates, value: messages.insights.gateCount(blocked, approvals), percentage: total > 0 ? ratio(blocked, total) : 0, tone: blocked > 0 ? 'warning' : 'neutral' },
    { id: 'context', label: messages.insights.contextCare, value: messages.insights.compactionCount(compacted), percentage: compacted > 0 ? 100 : 0, tone: compacted > 0 ? 'warning' : 'neutral' },
  ] as const;

  return (
    <section className="control-insights" aria-label={messages.insights.aria}>
      <div className="control-insights-heading">
        <div>
          <div className="snapshot-eyebrow">{messages.insights.eyebrow}</div>
          <h2>{messages.insights.title}</h2>
        </div>
        <span className="control-insights-source">{messages.insights.liveSource}</span>
      </div>
      {!snapshot && <p className="control-insights-empty">{messages.insights.empty}</p>}
      {snapshot && (
        <div className="control-insights-grid">
          {metrics.map((metric) => (
            <article className="control-metric" key={metric.id}>
              <div className="control-metric-label">{metric.label}</div>
              <strong>{metric.value}</strong>
              <div className="control-meter" aria-hidden="true">
                <span className={`control-meter-fill ${metric.tone}`} style={{ width: `${metric.percentage}%` }} />
              </div>
            </article>
          ))}
        </div>
      )}
      {snapshot && <p className="control-insights-note">{messages.insights.note}</p>}
    </section>
  );
}
