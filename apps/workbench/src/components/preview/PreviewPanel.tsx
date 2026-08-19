import { useState } from 'react';
import { useLocale } from '../../i18n/LocaleProvider';
import { CitationPreview } from './CitationPreview';
import { HttpKnowledgeSearchClient, type CitationPreview as Citation } from '../../runtime/knowledge-client';

type ViewKey = 'markdown' | 'html' | 'diff' | 'citations';

const knowledgeClient = new HttpKnowledgeSearchClient();
const TABS: readonly ViewKey[] = ['markdown', 'html', 'diff', 'citations'];

export function PreviewPanel() {
  const [active, setActive] = useState<ViewKey>('markdown');
  const [query, setQuery] = useState('');
  const [citations, setCitations] = useState<readonly Citation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [deliveryDraft, setDeliveryDraft] = useState('');
  const [editingDraft, setEditingDraft] = useState(false);
  const { messages } = useLocale();

  const searchKnowledge = async (): Promise<void> => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      setCitations(await knowledgeClient.search(query));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : messages.preview.knowledgeError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="preview-panel" aria-label={messages.preview.aria}>
      <header className="preview-header">
        <div>
          <div className="preview-title">{messages.preview.title}</div>
          <div className="preview-subtitle">{messages.preview.subtitle}</div>
        </div>
        <span className="status-chip"><span className="status-dot" />{messages.common.local}</span>
      </header>
      <div className="preview-tabs" role="tablist" aria-label={messages.preview.tabsAria}>
        {TABS.map((tab) => (
          <button
            aria-selected={active === tab}
            className={`preview-tab${active === tab ? ' active' : ''}`}
            key={tab}
            onClick={() => setActive(tab)}
            role="tab"
            type="button"
          >
            {messages.preview.tabs[tab]}
          </button>
        ))}
      </div>
      {active === 'citations' ? (
        <CitationPreview
          citations={citations}
          error={error}
          loading={loading}
          onQueryChange={setQuery}
          onSearch={() => void searchKnowledge()}
          query={query}
        />
      ) : active === 'markdown' ? (
        <section className="preview-canvas delivery-draft" aria-label={messages.preview.draft.aria}>
          <div className="preview-draft-heading">
            <div>
              <div className="preview-artifact-type">markdown draft</div>
              <h2>{messages.preview.markdown.title}</h2>
            </div>
            <button className="draft-toggle" onClick={() => setEditingDraft((current) => !current)} type="button">
              {editingDraft ? messages.preview.draft.preview : messages.preview.draft.edit}
            </button>
          </div>
          {editingDraft ? (
            <textarea
              aria-label={messages.preview.draft.aria}
              className="delivery-draft-editor"
              onChange={(event) => setDeliveryDraft(event.target.value)}
              placeholder={messages.preview.draft.placeholder}
              value={deliveryDraft}
            />
          ) : deliveryDraft ? (
            <pre className="delivery-draft-preview">{deliveryDraft}</pre>
          ) : (
            <p>{messages.preview.draft.empty}</p>
          )}
          <div className="delivery-draft-boundary">
            <span>{messages.preview.draft.localOnly}</span>
            <p>{messages.preview.draft.note}</p>
          </div>
        </section>
      ) : (
        <section className="preview-canvas">
          <div className="preview-artifact-type">{active} artifact</div>
          <h2>{messages.preview[active].title}</h2>
          <p>{messages.preview[active].description}</p>
          <div className="preview-lines" aria-hidden="true">
            <div className="preview-line" />
            <div className="preview-line short" />
            <div className="preview-line" />
            <div className="preview-line short" />
          </div>
        </section>
      )}
    </aside>
  );
}
