import { useCallback, useMemo, useState } from 'react';
import { directProviderClient } from './direct-provider-client';

export interface DirectConversationSelection { readonly providerId: string; readonly model?: string; }
export interface DirectConversationMessage { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string; readonly createdAt: number; readonly model?: string; }
export interface DirectConversation { readonly schemaVersion: 1; readonly id: string; readonly title: string; readonly selection: DirectConversationSelection; readonly messages: readonly DirectConversationMessage[]; readonly createdAt: number; readonly updatedAt: number; }

const STORAGE_KEY = 'awo.direct-conversations.v1';
const MAX_CONVERSATIONS = 32;
const MAX_MESSAGES = 200;

function safeSelection(value: unknown): DirectConversationSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<DirectConversationSelection>;
  if (typeof input.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.providerId)) return undefined;
  if (input.model !== undefined && (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.model))) return undefined;
  return { providerId: input.providerId, ...(input.model ? { model: input.model } : {}) };
}

function safeMessage(value: unknown): DirectConversationMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<DirectConversationMessage>;
  const createdAt = input.createdAt;
  if ((input.role !== 'user' && input.role !== 'assistant') || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 24_000 || typeof input.id !== 'string' || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) return undefined;
  return { id: input.id, role: input.role, text: input.text, createdAt, ...(typeof input.model === 'string' ? { model: input.model } : {}) };
}

function safeConversation(value: unknown): DirectConversation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<DirectConversation>;
  const selection = safeSelection(input.selection);
  const createdAt = input.createdAt;
  const updatedAt = input.updatedAt;
  if (!selection || input.schemaVersion !== 1 || typeof input.id !== 'string' || typeof input.title !== 'string' || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || !Array.isArray(input.messages)) return undefined;
  return { schemaVersion: 1, id: input.id, title: input.title.slice(0, 80), selection, messages: input.messages.map(safeMessage).filter((item): item is DirectConversationMessage => Boolean(item)).slice(-MAX_MESSAGES), createdAt, updatedAt };
}

function load(): readonly DirectConversation[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(safeConversation).filter((item): item is DirectConversation => Boolean(item)).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_CONVERSATIONS);
  } catch { return []; }
}

function persist(conversations: readonly DirectConversation[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)));
}

function nextId(prefix: string): string { return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`; }
function titleFor(prompt: string): string { return prompt.trim().replace(/\s+/g, ' ').slice(0, 48) || '新对话'; }
function streamingAssistantMessage(conversationId: string, text: string, createdAt: number, model?: string): DirectConversationMessage {
  return { id: `${conversationId}-stream`, role: 'assistant', text: text || '…', createdAt, ...(model ? { model } : {}) };
}

function streamErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const messages: Record<string, string> = {
    'provider-not-connected': '当前模型尚未在本次桌面会话中连接。请在“管理 API 连接”中点击“连接并测试”后重试。',
    'provider-http-401': '第三方服务拒绝了 API key；请检查密钥、账号或套餐。',
    'provider-http-403': '第三方服务拒绝访问；请检查账号权限、套餐与模型可用性。',
    'provider-http-429': '第三方服务正在限流，请稍后重试。',
    'provider-request-failed': '第三方服务未响应；请检查网络、Base URL 与供应商服务状态。',
    'provider-request-rejected': '第三方服务拒绝了当前协议、地址、模型或请求参数；请按供应商文档核对后重试。',
  };
  return messages[message] ?? (message && !/[<{]/.test(message) ? message : '第三方模型请求未完成。');
}

export interface DirectConversations {
  readonly conversations: readonly DirectConversation[];
  readonly activeConversation?: DirectConversation;
  readonly streaming: boolean;
  readonly error?: string;
  create(selection: DirectConversationSelection): string;
  select(id: string): void;
  send(selection: DirectConversationSelection, prompt: string): Promise<boolean>;
}

/** AtomCode 式“可继续、可切换”的对话历史；保存用户消息和模型文本，不保存密钥、Base URL 或请求头。 */
export function useDirectConversations(): DirectConversations {
  const [conversations, setConversations] = useState<readonly DirectConversation[]>(load);
  const [activeId, setActiveId] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string>();
  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === activeId) ?? conversations[0], [activeId, conversations]);

  const update = useCallback((transform: (current: readonly DirectConversation[]) => readonly DirectConversation[]): void => setConversations((current) => {
    const next = [...transform(current)].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_CONVERSATIONS);
    persist(next); return next;
  }), []);

  const create = useCallback((selection: DirectConversationSelection): string => {
    const now = Date.now(); const id = nextId('conversation');
    const conversation: DirectConversation = { schemaVersion: 1, id, title: '新对话', selection, messages: [], createdAt: now, updatedAt: now };
    update((current) => [conversation, ...current]); setActiveId(id); return id;
  }, [update]);

  const select = useCallback((id: string): void => { if (/^conversation-[A-Za-z0-9]{20}$/.test(id)) setActiveId(id); }, []);

  const send = useCallback(async (selection: DirectConversationSelection, prompt: string): Promise<boolean> => {
    const text = prompt.trim(); if (!text || streaming) return false;
    const now = Date.now(); const existing = activeConversation?.selection.providerId === selection.providerId ? activeConversation : undefined;
    const conversationId = existing?.id ?? nextId('conversation');
    const userMessage: DirectConversationMessage = { id: nextId('message'), role: 'user', text, createdAt: now };
    const base: DirectConversation = existing ?? { schemaVersion: 1, id: conversationId, title: titleFor(text), selection, messages: [], createdAt: now, updatedAt: now };
    update((current) => [{ ...base, selection, title: base.messages.length === 0 ? titleFor(text) : base.title, messages: [...base.messages, userMessage].slice(-MAX_MESSAGES), updatedAt: now }, ...current.filter((item) => item.id !== conversationId)]);
    setActiveId(conversationId); setStreaming(true); setError(undefined);
    let output = '';
    try {
      const completion = await directProviderClient.stream({ providerId: selection.providerId, model: selection.model, prompt: text, onText: (chunk) => { output += chunk; update((current) => current.map((conversation) => conversation.id !== conversationId ? conversation : ({ ...conversation, messages: [...conversation.messages.filter((message) => message.id !== `${conversationId}-stream`), streamingAssistantMessage(conversationId, output, now, selection.model)].slice(-MAX_MESSAGES), updatedAt: Date.now() }))); } });
      update((current) => current.map((conversation) => conversation.id !== conversationId ? conversation : ({ ...conversation, messages: conversation.messages.map((message) => message.id !== `${conversationId}-stream` ? message : { ...message, ...(completion.model ? { model: completion.model } : {}) }), updatedAt: Date.now() })));
      return true;
    } catch (nextError: unknown) {
      setError(streamErrorText(nextError));
      update((current) => current.map((conversation) => conversation.id !== conversationId ? conversation : ({ ...conversation, messages: conversation.messages.filter((message) => message.id !== `${conversationId}-stream`), updatedAt: Date.now() })));
      return false;
    } finally { setStreaming(false); }
  }, [activeConversation, streaming, update]);

  return { conversations, activeConversation, streaming, error, create, select, send };
}
