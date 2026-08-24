export type SearchRunMode = 'web-search' | 'hybrid' | 'searxng-local' | 'last30days' | 'last30days-cn';
export type SearchRunKind = 'web-search' | 'research' | 'hybrid-search' | 'searxng';

export function isSearchRunKind(kind: string): kind is SearchRunKind {
  return kind === 'web-search' || kind === 'research' || kind === 'hybrid-search' || kind === 'searxng';
}

export function searchRunMode(kind: SearchRunKind, text: string): SearchRunMode {
  if (kind === 'web-search') return 'web-search';
  if (kind === 'hybrid-search') return 'hybrid';
  if (kind === 'searxng') return 'searxng-local';
  return /中文/.test(text) ? 'last30days-cn' : 'last30days';
}

export function searchRunStatus(text: string): 'succeeded' | 'failed' {
  return /(未完成|失败|超时|拒绝|无法|未返回|未检索到|退出)/.test(text) ? 'failed' : 'succeeded';
}

export function searchRunLabel(kind: SearchRunKind, text: string): string {
  if (kind === 'web-search') return '网页检索 · Exa';
  if (kind === 'hybrid-search') return '混合检索 · 并行后端';
  if (kind === 'searxng') return '本地 SearXNG · Loopback';
  return /中文/.test(text) ? '近 30 天研究 · 中文来源' : '近 30 天研究 · 国际来源';
}
