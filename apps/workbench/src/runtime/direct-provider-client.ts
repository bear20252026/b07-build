import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type DirectProviderProtocol = 'openai-compatible' | 'anthropic-compatible';
export interface DirectProviderMessage { readonly role: 'user' | 'assistant'; readonly content: string; }

export interface DirectProviderConnection {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly displayName: string;
  readonly defaultModel: string;
  readonly protocol: DirectProviderProtocol;
  readonly connected: true;
  readonly canReadSecret: false;
}

interface NativeProviderStatus {
  schemaVersion: number;
  providerId: string;
  model: string;
  protocol: DirectProviderProtocol;
  connected: boolean;
  canReadSecret: boolean;
}

interface NativeModelDiscovery {
  schemaVersion: number;
  providerId: string;
  models: unknown;
}

interface NativeStreamEvent {
  requestId: string;
  kind: 'text' | 'reasoning' | 'done' | 'error';
  text?: string;
  model?: string;
  message?: string;
}

function requireIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) throw new Error(`${field} 无效`);
  return trimmed;
}

function requireModelIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(trimmed)) throw new Error('模型名称无效');
  return trimmed;
}

function requestId(): string {
  return `stream-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function assertNativeStatus(value: NativeProviderStatus): void {
  if (value.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.providerId) || !value.model || !['openai-compatible', 'anthropic-compatible'].includes(value.protocol) || value.connected !== true || value.canReadSecret !== false) throw new Error('桌面 Provider 返回了无效状态');
}

/** Tauri 直接 Provider 通讯：API key 只经 invoke 交给原生进程；文本通过原生事件按 SSE 分块到达。 */
export class DirectProviderClient {
  async configure(input: { providerId: string; displayName: string; protocol: DirectProviderProtocol; baseUrl: string; model: string; apiKey: string }): Promise<DirectProviderConnection> {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 80 || !input.baseUrl.trim() || !input.model.trim() || !input.apiKey.trim()) throw new Error('连接信息不完整');
    const status = await invoke<NativeProviderStatus>('configure_direct_provider', { request: { providerId, protocol: input.protocol, baseUrl: input.baseUrl.trim(), model: input.model.trim(), apiKey: input.apiKey.trim() } });
    assertNativeStatus(status);
    return { schemaVersion: 1, providerId, displayName, defaultModel: status.model, protocol: status.protocol, connected: true, canReadSecret: false };
  }

  async probe(providerId: string): Promise<void> {
    const safeProviderId = requireIdentifier(providerId, 'providerId');
    await invoke('probe_direct_provider', { request: { providerId: safeProviderId } });
  }

  async discover(providerId: string): Promise<readonly string[]> {
    const safeProviderId = requireIdentifier(providerId, 'providerId');
    const result = await invoke<NativeModelDiscovery>('discover_direct_provider', { request: { providerId: safeProviderId } });
    if (result.schemaVersion !== 1 || result.providerId !== safeProviderId || !Array.isArray(result.models)) throw new Error('模型目录返回无效');
    return [...new Set(result.models.filter((model): model is string => typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)))].sort().slice(0, 100);
  }

  async stream(input: { providerId: string; messages: readonly DirectProviderMessage[]; model?: string; onText(text: string): void; onReasoning?(text: string): void }): Promise<{ model?: string }> {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    if (input.messages.length === 0 || input.messages.length > 48) throw new Error('当前会话历史无效或过长');
    const messages = input.messages.map((message) => {
      const content = message.content.trim();
      if (!['user', 'assistant'].includes(message.role) || !content || content.length > 24_000) throw new Error('会话消息无效');
      return { role: message.role, content };
    });
    if (messages.reduce((length, message) => length + message.content.length, 0) > 72_000) throw new Error('当前会话上下文过长，请新建对话后重试');
    if (input.model !== undefined) requireModelIdentifier(input.model);
    const id = requestId();
    let unlisten: UnlistenFn | undefined;
    return new Promise<{ model?: string }>((resolve, reject) => {
      const finish = (result: { model?: string } | Error): void => {
        unlisten?.();
        result instanceof Error ? reject(result) : resolve(result);
      };
      void listen<NativeStreamEvent>('direct-provider-stream', (event) => {
        const payload = event.payload;
        if (!payload || payload.requestId !== id) return;
        if (payload.kind === 'text' && typeof payload.text === 'string') { input.onText(payload.text); return; }
        if (payload.kind === 'reasoning' && typeof payload.text === 'string') { input.onReasoning?.(payload.text); return; }
        if (payload.kind === 'done') { finish(typeof payload.model === 'string' ? { model: payload.model } : {}); return; }
        if (payload.kind === 'error') { finish(new Error(typeof payload.message === 'string' ? payload.message : '第三方模型请求未完成')); }
      }).then((dispose) => {
        unlisten = dispose;
        return invoke('start_direct_provider_stream', { request: { providerId, messages, ...(input.model?.trim() ? { model: input.model.trim() } : {}), requestId: id } });
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error('无法启动第三方模型请求')));
    });
  }
}

export const directProviderClient = new DirectProviderClient();
