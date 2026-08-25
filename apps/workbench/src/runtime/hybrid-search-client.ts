import { invoke } from '@tauri-apps/api/core';

export interface HybridSearchSource { readonly backend: string; readonly title: string; readonly url: string; }
export interface HybridSearchReceipt { readonly backend: string; readonly state: 'succeeded' | 'failed'; readonly detail: string; readonly sourceCount: number; }
export interface HybridSearchResult { readonly query: string; readonly rawContent: string; readonly sources: readonly HybridSearchSource[]; readonly receipts: readonly HybridSearchReceipt[]; }

function validSource(value: unknown): value is HybridSearchSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<HybridSearchSource>;
  return typeof source.backend === 'string' && /^[a-z0-9-]{2,64}$/.test(source.backend) && typeof source.title === 'string' && source.title.length <= 160 && typeof source.url === 'string' && /^https?:\/\//.test(source.url) && source.url.length <= 2_048;
}

function validReceipt(value: unknown): value is HybridSearchReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<HybridSearchReceipt>;
  return typeof receipt.backend === 'string' && /^[a-z0-9-]{2,64}$/.test(receipt.backend) && (receipt.state === 'succeeded' || receipt.state === 'failed') && typeof receipt.detail === 'string' && receipt.detail.length <= 1_000 && typeof receipt.sourceCount === 'number' && Number.isSafeInteger(receipt.sourceCount) && receipt.sourceCount >= 0 && receipt.sourceCount <= 1_000;
}

export function hybridSearchResultFrom(value: unknown): HybridSearchResult {
  if (!value || typeof value !== 'object') throw new Error('hybrid-search-response-invalid');
  const result = value as Partial<HybridSearchResult>;
  if (typeof result.query !== 'string' || !result.query.trim() || typeof result.rawContent !== 'string' || !result.rawContent.trim() || result.rawContent.length > 1_000_000 || !Array.isArray(result.sources) || !Array.isArray(result.receipts)) throw new Error('hybrid-search-response-invalid');
  if (!result.receipts.every(validReceipt)) throw new Error('hybrid-search-response-invalid');
  return { query: result.query, rawContent: result.rawContent, sources: result.sources.filter(validSource).slice(0, 10), receipts: result.receipts.slice(0, 8) };
}

export const hybridSearchClient = {
  async search(query: string): Promise<HybridSearchResult> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 2_000) throw new Error('hybrid-search-query-invalid');
    return hybridSearchResultFrom(await invoke('search_hybrid', { request: { query: normalized } }));
  },
};
