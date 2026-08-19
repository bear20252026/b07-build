import type { FormEvent } from 'react';
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
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSearch();
  };

  return (
    <section className="citation-preview" aria-label="本地知识引用预览">
      <div className="citation-header">
        <div>
          <div className="citation-eyebrow">Local knowledge</div>
          <h2>引用预览</h2>
        </div>
        <span className="citation-count">{citations.length} 条</span>
      </div>
      <form className="citation-search" onSubmit={submit}>
        <input
          aria-label="检索本地知识"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="检索本地知识…"
          value={query}
        />
        <button disabled={!query.trim() || loading} type="submit">{loading ? '检索中' : '检索'}</button>
      </form>
      {error && <div className="citation-error" role="alert">{error}</div>}
      {citations.length === 0 && !loading && !error && (
        <p className="citation-empty">输入关键词后，将显示本机 SQLite 向量索引中的可追溯来源片段。</p>
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
