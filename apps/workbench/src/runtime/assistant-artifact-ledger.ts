export type AssistantArtifactTarget = 'app-managed' | 'selected-workspace';

export interface AssistantArtifactEntry {
  readonly artifactId: string;
  readonly logicalPath: string;
  readonly displayName: string;
  readonly byteSize: number;
  readonly createdAt: number;
  readonly target: AssistantArtifactTarget;
}

const STORAGE_KEY = 'awo.assistant-artifacts.v1';
const MAX_ENTRIES = 48;

function isEntry(value: unknown): value is AssistantArtifactEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.artifactId === 'string'
    && typeof item.logicalPath === 'string'
    && /^assistant-replies\/[A-Za-z0-9][A-Za-z0-9._-]{2,76}\.md$/.test(item.logicalPath)
    && typeof item.displayName === 'string'
    && typeof item.byteSize === 'number' && Number.isInteger(item.byteSize) && item.byteSize > 0 && item.byteSize <= 512_000
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
    && (item.target === 'app-managed' || item.target === 'selected-workspace');
}

export function loadAssistantArtifacts(storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): readonly AssistantArtifactEntry[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEntry).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function persistAssistantArtifacts(entries: readonly AssistantArtifactEntry[], storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): readonly AssistantArtifactEntry[] {
  const bounded = entries.filter(isEntry).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ENTRIES);
  storage?.setItem(STORAGE_KEY, JSON.stringify(bounded));
  return bounded;
}

export function assistantArtifactFileName(createdAt: number): string {
  const stamp = new Date(createdAt).toISOString().replace(/[-:]/g, '');
  return `ai-reply-${stamp}.md`;
}
