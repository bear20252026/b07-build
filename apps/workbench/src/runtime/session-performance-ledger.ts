export type SessionPerformanceKind = 'conversation-persist' | 'stream-refresh' | 'timeline-frame';

export interface SessionPerformanceEntry {
  readonly schemaVersion: 1;
  readonly at: number;
  readonly kind: SessionPerformanceKind;
  readonly elapsedMs: number;
  readonly conversationCount: number;
  readonly messageCount: number;
  readonly renderedMessageCount?: number;
}

const STORAGE_KEY = 'awo.session-performance-ledger.v1';
const MAX_ENTRIES = 128;
let entries: readonly SessionPerformanceEntry[] = load();
const listeners = new Set<() => void>();
const lastRecordedAt = new Map<SessionPerformanceKind, number>();
const MIN_SAMPLE_INTERVAL_MS = 500;

function storage(): Storage | undefined { return typeof window === 'undefined' ? undefined : window.localStorage; }
function validEntry(value: unknown): value is SessionPerformanceEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SessionPerformanceEntry>;
  return entry.schemaVersion === 1 && ['conversation-persist', 'stream-refresh', 'timeline-frame'].includes(String(entry.kind)) && typeof entry.at === 'number' && Number.isSafeInteger(entry.at) && typeof entry.elapsedMs === 'number' && Number.isFinite(entry.elapsedMs) && typeof entry.conversationCount === 'number' && Number.isSafeInteger(entry.conversationCount) && typeof entry.messageCount === 'number' && Number.isSafeInteger(entry.messageCount) && (entry.renderedMessageCount === undefined || (typeof entry.renderedMessageCount === 'number' && Number.isSafeInteger(entry.renderedMessageCount)));
}
function load(): readonly SessionPerformanceEntry[] { try { const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]'); return Array.isArray(parsed) ? parsed.filter(validEntry).slice(0, MAX_ENTRIES) : []; } catch { return []; } }
function persist(): void { try { storage()?.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* 存储空间不足时只保留当前内存观察。 */ } }

/** 只记录数值型本地 UI 指标；调用方不得传入或推导正文、Provider、端点、文件名或密钥。 */
export function recordSessionPerformance(input: Omit<SessionPerformanceEntry, 'schemaVersion' | 'at'>): void {
  const at = Date.now();
  if (at - (lastRecordedAt.get(input.kind) ?? 0) < MIN_SAMPLE_INTERVAL_MS) return;
  lastRecordedAt.set(input.kind, at);
  const entry: SessionPerformanceEntry = { schemaVersion: 1, at, kind: input.kind, elapsedMs: Math.max(0, Math.round(input.elapsedMs)), conversationCount: Math.max(0, input.conversationCount), messageCount: Math.max(0, input.messageCount), ...(input.renderedMessageCount === undefined ? {} : { renderedMessageCount: Math.max(0, input.renderedMessageCount) }) };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES); persist(); listeners.forEach((listener) => listener());
}
export function sessionPerformanceEntries(): readonly SessionPerformanceEntry[] { return entries; }
export function subscribeSessionPerformance(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function resetSessionPerformanceForTest(): void { entries = []; lastRecordedAt.clear(); storage()?.removeItem(STORAGE_KEY); }
