import type { Translation } from '../../i18n/catalog';
import type { WorkbenchLocalModelHealth } from '../../runtime/task-client';

interface LocalModelHealthBoardProps {
  readonly models: readonly WorkbenchLocalModelHealth[] | undefined;
  readonly error?: string;
  readonly messages: Translation;
}

function checkedAt(value: number | undefined, messages: Translation): string {
  return value === undefined ? messages.localModels.notChecked : new Date(value).toLocaleString();
}

/**
 * 本地模型 endpoint 的只读健康投影。它从不调用 probe、注册 profile 或暴露 URL / credential reference。
 */
export function LocalModelHealthBoard({ models, error, messages }: LocalModelHealthBoardProps) {
  return (
    <section className="local-model-board" aria-label={messages.localModels.aria}>
      <div className="local-model-heading">
        <div>
          <div className="local-model-eyebrow">{messages.localModels.eyebrow}</div>
          <h2>{messages.localModels.title}</h2>
        </div>
        <span className="local-model-count">{models ? messages.localModels.count(models.length) : messages.common.processing}</span>
      </div>
      {error ? (
        <p className="local-model-empty">{messages.common.local}: {error}</p>
      ) : !models ? (
        <p className="local-model-empty">{messages.localModels.loading}</p>
      ) : models.length === 0 ? (
        <p className="local-model-empty">{messages.localModels.empty}</p>
      ) : (
        <ul className="local-model-list">
          {models.map((model) => (
            <li className="local-model-item" key={model.id}>
              <div className="local-model-item-heading">
                <div>
                  <strong>{model.id}</strong>
                  <span>{messages.localModels.configuredModel}: {model.configuredModelId}</span>
                </div>
                <span className={`local-model-status ${model.offline ? 'offline' : model.health.status}`}>
                  {model.offline ? messages.localModels.offline : messages.localModels.status[model.health.status]}
                </span>
              </div>
              <div className="local-model-meta">
                <span>{messages.localModels.checkedAt}: {checkedAt(model.health.checkedAt, messages)}</span>
                <span>{messages.localModels.discovered}: {model.health.modelIds.length ? model.health.modelIds.join(', ') : messages.localModels.none}</span>
              </div>
              {model.health.error && <p className="local-model-error">{model.health.error}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="local-model-note">{messages.localModels.note}</p>
    </section>
  );
}
