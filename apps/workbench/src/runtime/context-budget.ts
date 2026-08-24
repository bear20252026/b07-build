import type { DirectConversationMessage } from './use-direct-conversations';

export const MAX_PROVIDER_HISTORY_CHARS = 1_000_000;

export interface ContextBudgetSnapshot {
  readonly limit: number;
  readonly historyCharacters: number;
  readonly memoryCharacters: number;
  readonly draftCharacters: number;
  readonly pendingAttachmentBytes: number;
  readonly totalTextCharacters: number;
  readonly ratio: number;
  readonly state: 'comfortable' | 'watch' | 'near-limit';
}

export function contextBudget(input: Readonly<{ messages: readonly DirectConversationMessage[]; memory: string; draft: string; pendingAttachmentBytes: number }>): ContextBudgetSnapshot {
  const historyCharacters = input.messages.reduce((total, message) => total + (message.context ?? message.text).length, 0);
  const memoryCharacters = input.memory.length;
  const draftCharacters = input.draft.trim().length;
  const totalTextCharacters = historyCharacters + memoryCharacters + draftCharacters;
  const ratio = totalTextCharacters / MAX_PROVIDER_HISTORY_CHARS;
  return {
    limit: MAX_PROVIDER_HISTORY_CHARS,
    historyCharacters,
    memoryCharacters,
    draftCharacters,
    pendingAttachmentBytes: Math.max(0, input.pendingAttachmentBytes),
    totalTextCharacters,
    ratio,
    state: ratio >= 0.85 ? 'near-limit' : ratio >= 0.6 ? 'watch' : 'comfortable',
  };
}
