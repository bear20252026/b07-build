import type { DirectConversationMessage } from './use-direct-conversations';

/** 安全上限：任何情况下都不会超过的字符数，防止单个异常会话把请求体撑爆。 */
export const MAX_PROVIDER_HISTORY_CHARS = 1_000_000;

/** 未知模型时的保守窗口。多数当代模型在 128K token 量级，取它比固定 100 万字符安全得多。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/** 给回复预留的 token，历史不能占满整个窗口。 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;
/**
 * 粗估：中英混排按每 token 约 3 个字符折算（中文偏 2、英文偏 4，取保守值）。
 * 与 ZCode 的做法一致——只用于预算裁决，不是精确 tokenizer。
 */
export const ESTIMATED_CHARS_PER_TOKEN = 3;

/**
 * 按模型的真实上下文窗口（token）。
 *
 * 这里只填写**已经逐项核对过厂商官方文档**的条目；未核实的模型一律走 DEFAULT_CONTEXT_WINDOW_TOKENS，
 * 绝不猜测。新增条目时请同时补一条 context-budget.test.ts 断言与厂商文档出处。
 */
export const MODEL_CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = Object.freeze({});

export function contextWindowTokensFor(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  const declared = MODEL_CONTEXT_WINDOW_TOKENS[model];
  return typeof declared === 'number' && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** 模型窗口折算出的历史字符预算，且永不超过安全上限。 */
export function historyCharBudgetFor(model?: string): number {
  const tokens = Math.max(1, contextWindowTokensFor(model) - DEFAULT_OUTPUT_RESERVE_TOKENS);
  return Math.min(MAX_PROVIDER_HISTORY_CHARS, Math.floor(tokens * ESTIMATED_CHARS_PER_TOKEN));
}

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

export function contextBudget(input: Readonly<{ messages: readonly DirectConversationMessage[]; memory: string; draft: string; pendingAttachmentBytes: number; model?: string }>): ContextBudgetSnapshot {
  const historyCharacters = input.messages.reduce((total, message) => total + (message.context ?? message.text).length, 0);
  const memoryCharacters = input.memory.length;
  const draftCharacters = input.draft.trim().length;
  const totalTextCharacters = historyCharacters + memoryCharacters + draftCharacters;
  const limit = historyCharBudgetFor(input.model);
  const ratio = totalTextCharacters / limit;
  return {
    limit,
    historyCharacters,
    memoryCharacters,
    draftCharacters,
    pendingAttachmentBytes: Math.max(0, input.pendingAttachmentBytes),
    totalTextCharacters,
    ratio,
    state: ratio >= 0.85 ? 'near-limit' : ratio >= 0.6 ? 'watch' : 'comfortable',
  };
}
