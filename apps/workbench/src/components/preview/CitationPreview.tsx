import type { FormEvent } from 'react';
import { useLocale } from '../../i18n/LocaleProvider';
import type { CitationPreview as Citation } from '../../runtime/knowledge-client';

export interface CitationPreviewProps {
  query: string;
  citations: readonly Citation[];
  loading: boolean;
  error?: string;
  onQueryChange(query: string): void;
  onSearch(): void;
}

function sourceLabel(sourceUri: string): string {
  try {
    const parsed = new URL(sourceUri);
    return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname) : parsed.hostname || sourceUri;
  } catch {
    return sourceUri;
  }
}

export function CitationPreview({
  query,
  citations,
  loading,
  error,
  onQueryChange,
  onSearch,
}: CitationPreviewProps) {
  const { messages } = useLocale();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSearch();
  };

  return (
    <section className="citation-preview" aria-label={messages.citation.aria}>
      <div className="citation-header">
        <div>
          <div className="citation-eyebrow">{messages.citation.eyebrow}</div>
          <h2>{messages.citation.title}</h2>
        </div>
        <span className="citation-count">{messages.citation.count(citations.length)}</span>
      </div>
      <form className="citation-search" onSubmit={submit}>
        <input
          aria-label={messages.citation.searchAria}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={messages.citation.placeholder}
          value={query}
        />
        <button disabled={!query.trim() || loading} type="submit">{loading ? messages.citation.loading : messages.citation.search}</button>
      </form>
      {error && <div className="citation-error" role="alert">{error}</div>}
      {citations.length === 0 && !loading && !error && (
        <p className="citation-empty">{messages.citation.empty}</p>
      )}
      <div className="citation-list">
        {citations.map((citation) => (
          <article className="citation-card" key={citation.chunkId}>
            <div className="citation-title-row">
              <strong>{citation.title}</strong>
              <span>{citation.score.toFixed(2)}</span>
            </div>
            <p>{citation.excerpt}</p>
            <a href={citation.sourceUri} title={citation.sourceUri}>{sourceLabel(citation.sourceUri)}</a>
          </article>
        ))}
      </div>
    </section>
  );
}
