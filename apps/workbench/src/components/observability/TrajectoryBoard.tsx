import type { Translation } from '../../i18n/catalog';
import type { WorkbenchRunTrajectoryEvent } from '../../runtime/task-client';

interface TrajectoryBoardProps {
  readonly events: readonly WorkbenchRunTrajectoryEvent[];
  readonly messages: Translation;
}

function formatAttributes(attributes: Readonly<Record<string, string | number | boolean>>): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');
}

/** 只读审计投影；没有批准、恢复、启动、重放或凭据读取接口。 */
export function TrajectoryBoard({ events, messages }: TrajectoryBoardProps) {
  return (
    <section className="trajectory-board" aria-label={messages.trajectory.aria}>
      <div className="trajectory-heading">
        <div>
          <div className="trajectory-eyebrow">{messages.trajectory.eyebrow}</div>
          <h2>{messages.trajectory.title}</h2>
        </div>
        <span className="trajectory-count">{messages.trajectory.count(events.length)}</span>
      </div>
      {events.length === 0 ? (
        <p className="trajectory-empty">{messages.trajectory.empty}</p>
      ) : (
        <ol className="trajectory-list">
          {events.map((event) => (
            <li className="trajectory-event" key={event.trajectoryEventId}>
              <span className="trajectory-sequence">{event.sequence}</span>
              <div>
                <div className="trajectory-event-title">{event.kind}</div>
                <div className="trajectory-event-meta">{messages.trajectory.source}: {event.source} · {formatAttributes(event.attributes)}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="trajectory-note">{messages.trajectory.cannotReplay}</p>
    </section>
  );
}
