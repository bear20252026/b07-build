export type LocalKnowledgeSourceKind = 'manual-text' | 'selected-file';

export interface LocalKnowledgeDocument {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId?: string;
  readonly title: string;
  readonly sourceKind: LocalKnowledgeSourceKind;
  readonly declaredBytes: number;
  readonly indexedAt: number;
  readonly termIndex: readonly string[];
  readonly sourcePreview: string;
}

const STORAGE_KEY = 'awo.local-knowledge-ledger.v1';
const MAX_DOCUMENTS = 48;
const MAX_TERMS = 160;
const MAX_PREVIEW_CHARS = 700;

function storage(): Storage | undefined { return typeof window === 'undefined' ? undefined : window.localStorage; }
function validDocument(value: unknown): value is LocalKnowledgeDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Partial<LocalKnowledgeDocument>;
  return document.schemaVersion === 1 && typeof document.id === 'string' && typeof document.title === 'string' && (document.sourceKind === 'manual-text' || document.sourceKind === 'selected-file') && typeof document.declaredBytes === 'number' && Number.isSafeInteger(document.declaredBytes) && typeof document.indexedAt === 'number' && Number.isSafeInteger(document.indexedAt) && Array.isArray(document.termIndex) && document.termIndex.every((term) => typeof term === 'string') && typeof document.sourcePreview === 'string' && (document.projectId === undefined || /^project-[a-f0-9-]{8,80}$/.test(document.projectId));
}
function load(): readonly LocalKnowledgeDocument[] { try { const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]'); return Array.isArray(parsed) ? parsed.filter(validDocument).slice(0, MAX_DOCUMENTS) : []; } catch { return []; } }
let documents: readonly LocalKnowledgeDocument[] = load();
const listeners = new Set<() => void>();

function terms(text: string): readonly string[] {
  const normalized = text.toLocaleLowerCase();
  const wordTerms = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const cjk = [...normalized].filter((character) => /[\u3400-\u9fff]/u.test(character));
  const cjkTerms = Array.from({ length: Math.max(0, cjk.length - 1) }, (_, index) => `${cjk[index]}${cjk[index + 1]}`);
  return [...new Set([...wordTerms, ...cjkTerms])].slice(0, MAX_TERMS);
}
function preview(text: string): string { return text.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW_CHARS); }

/** 仅接受主人已选择的文本；只持久化有界术语索引与来源预览，不会发起网络请求或自动注入 Provider 上下文。 */
export function indexLocalKnowledge(input: Readonly<{ title: string; sourceKind: LocalKnowledgeSourceKind; text: string; declaredBytes: number; projectId?: string }>): LocalKnowledgeDocument | undefined {
  const title = input.title.trim().slice(0, 160); const text = input.text.trim();
  if (!title || !text || !Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 0) return undefined;
  const document: LocalKnowledgeDocument = { schemaVersion: 1, id: `knowledge-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, ...(input.projectId ? { projectId: input.projectId } : {}), title, sourceKind: input.sourceKind, declaredBytes: input.declaredBytes, indexedAt: Date.now(), termIndex: terms(`${title}\n${text}`), sourcePreview: preview(text) };
  documents = [document, ...documents].slice(0, MAX_DOCUMENTS);
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(documents)); } catch { /* 存储空间不足时仍返回当前会话中的可见索引。 */ }
  listeners.forEach((listener) => listener()); return document;
}
export function localKnowledgeDocuments(projectId?: string): readonly LocalKnowledgeDocument[] { return projectId ? documents.filter((document) => document.projectId === projectId) : documents; }
export function searchLocalKnowledge(query: string, projectId?: string): readonly LocalKnowledgeDocument[] {
  const queryTerms = terms(query); if (queryTerms.length === 0) return [];
  return localKnowledgeDocuments(projectId).map((document) => ({ document, score: queryTerms.reduce((total, term) => total + (document.termIndex.includes(term) ? 2 : 0) + (document.title.toLocaleLowerCase().includes(term) ? 3 : 0) + (document.sourcePreview.toLocaleLowerCase().includes(term) ? 1 : 0), 0) })).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score).map(({ document }) => document);
}
export function subscribeLocalKnowledge(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function resetLocalKnowledgeForTest(): void { documents = []; storage()?.removeItem(STORAGE_KEY); }
