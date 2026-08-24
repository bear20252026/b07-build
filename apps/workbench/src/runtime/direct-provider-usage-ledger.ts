export type DirectUsageLedgerStage = 'configured' | 'probe' | 'stream-test' | 'chat';
export type DirectUsageLedgerOutcome = 'succeeded' | 'failed';

export interface DirectUsageLedgerEntry {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly at: number;
  readonly providerId: string;
  readonly displayName: string;
  readonly model: string;
  readonly stage: DirectUsageLedgerStage;
  readonly outcome: DirectUsageLedgerOutcome;
  readonly elapsedMs: number;
  readonly firstByteMs?: number;
  readonly outputCharacters?: number;
  readonly conversationId?: string;
  readonly includedImages: boolean;
  readonly errorCode?: string;
}

const STORAGE_KEY = 'awo.direct-provider-usage-ledger.v1';
const MAX_ENTRIES = 128;
let entries: readonly DirectUsageLedgerEntry[] = load();
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function validEntry(value: unknown): value is DirectUsageLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DirectUsageLedgerEntry>;
  return entry.schemaVersion === 1 && typeof entry.traceId === 'string' && typeof entry.at === 'number' && typeof entry.providerId === 'string' && typeof entry.displayName === 'string' && typeof entry.model === 'string' && ['configured', 'probe', 'stream-test', 'chat'].includes(String(entry.stage)) && ['succeeded', 'failed'].includes(String(entry.outcome)) && typeof entry.elapsedMs === 'number' && typeof entry.includedImages === 'boolean';
}

function load(): readonly DirectUsageLedgerEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(validEntry).slice(0, MAX_ENTRIES) : [];
  } catch { return []; }
}

function persist(): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* 无存储空间时只保留当前内存账本。 */ }
}

export function recordDirectUsageLedger(input: DirectUsageLedgerEntry): void {
  entries = [input, ...entries.filter((entry) => entry.traceId !== input.traceId)].slice(0, MAX_ENTRIES);
  persist(); listeners.forEach((listener) => listener());
}

export function directUsageLedgerEntries(): readonly DirectUsageLedgerEntry[] { return entries; }
export function subscribeDirectUsageLedger(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function resetDirectUsageLedgerForTest(): void { entries = []; storage()?.removeItem(STORAGE_KEY); }
