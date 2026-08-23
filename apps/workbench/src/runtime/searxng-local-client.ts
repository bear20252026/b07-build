import { invoke } from '@tauri-apps/api/core';
import type { WebSearchResult, WebSearchSource } from './web-search-client';

function validSource(value: unknown): value is WebSearchSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<WebSearchSource>;
  return typeof source.title === 'string' && source.title.length <= 160 && typeof source.url === 'string' && /^https?:\/\//.test(source.url) && source.url.length <= 2_048;
}

export function searxngResultFrom(value: unknown): WebSearchResult {
  if (!value || typeof value !== 'object') throw new Error('searxng-response-invalid');
  const result = value as Partial<WebSearchResult>;
  if (typeof result.query !== 'string' || !result.query.trim() || typeof result.summary !== 'string' || !result.summary.trim() || typeof result.rawContent !== 'string' || !result.rawContent.trim() || result.rawContent.length > 1_000_000 || !Array.isArray(result.sources)) throw new Error('searxng-response-invalid');
  return { query: result.query, summary: result.summary, rawContent: result.rawContent, sources: result.sources.filter(validSource).slice(0, 16) };
}

export const searxngLocalClient = {
  async search(query: string): Promise<WebSearchResult> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 2_000) throw new Error('searxng-query-invalid');
    return searxngResultFrom(await invoke('search_searxng_local', { request: { query: normalized, maxResults: 8 } }));
  },
  async stop(): Promise<void> { await invoke('stop_searxng_local'); },
};
