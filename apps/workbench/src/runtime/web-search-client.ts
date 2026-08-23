import { invoke } from '@tauri-apps/api/core';

export interface WebSearchSource { readonly title: string; readonly url: string; }
export interface WebSearchResult { readonly query: string; readonly summary: string; readonly sources: readonly WebSearchSource[]; }

function validSource(value: unknown): value is WebSearchSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<WebSearchSource>;
  return typeof source.title === 'string' && source.title.length <= 160 && typeof source.url === 'string' && /^https?:\/\//.test(source.url) && source.url.length <= 2_048;
}

function resultFrom(value: unknown): WebSearchResult {
  if (!value || typeof value !== 'object') throw new Error('web-search-response-invalid');
  const result = value as Partial<WebSearchResult>;
  if (typeof result.query !== 'string' || typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 64_000 || !Array.isArray(result.sources)) throw new Error('web-search-response-invalid');
  return { query: result.query, summary: result.summary, sources: result.sources.filter(validSource).slice(0, 8) };
}

export const webSearchClient = {
  async search(query: string): Promise<WebSearchResult> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 2_000) throw new Error('web-search-query-invalid');
    return resultFrom(await invoke('search_web', { request: { query: normalized, maxResults: 5 } }));
  },
};
