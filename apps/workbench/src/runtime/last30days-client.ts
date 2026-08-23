import { invoke } from '@tauri-apps/api/core';
import type { WebSearchSource } from './web-search-client';

export type Last30DaysMode = 'last30days' | 'last30days-cn';

export interface Last30DaysResult {
  readonly query: string;
  readonly mode: Last30DaysMode;
  readonly rawContent: string;
  readonly sources: readonly WebSearchSource[];
}

function validSource(value: unknown): value is WebSearchSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<WebSearchSource>;
  return typeof source.title === 'string' && source.title.length <= 160 && typeof source.url === 'string' && /^https?:\/\//.test(source.url) && source.url.length <= 2_048;
}

export function last30daysResultFrom(value: unknown): Last30DaysResult {
  if (!value || typeof value !== 'object') throw new Error('last30days-response-invalid');
  const result = value as Partial<Last30DaysResult>;
  if ((result.mode !== 'last30days' && result.mode !== 'last30days-cn') || typeof result.query !== 'string' || !result.query.trim() || typeof result.rawContent !== 'string' || !result.rawContent.trim() || result.rawContent.length > 1_000_000 || !Array.isArray(result.sources)) throw new Error('last30days-response-invalid');
  return { query: result.query, mode: result.mode, rawContent: result.rawContent, sources: result.sources.filter(validSource).slice(0, 24) };
}

export const last30daysClient = {
  async research(query: string, mode: Last30DaysMode): Promise<Last30DaysResult> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 2_000) throw new Error('last30days-query-invalid');
    return last30daysResultFrom(await invoke('run_last30days_research', { request: { query: normalized, mode } }));
  },
};
