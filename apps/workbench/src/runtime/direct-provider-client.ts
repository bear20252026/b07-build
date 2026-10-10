import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type DirectProviderProtocol = 'openai-compatible' | 'anthropic-compatible';
export interface DirectProviderImage { readonly mediaType: string; readonly base64Data: string; }

/** 工具声明。`parameters` 是原样透传给模型的 JSON Schema，客户端不做解释。 */
export interface DirectProviderTool { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>>; }

/**
 * 模型发起的一次工具调用。
 * `arguments` 是上游拼接出来的**原始 JSON 文本**：流式 arguments 会被切成任意边界的片段，
 * 只有整段拼完后才保证可解析，所以这里保留字符串，由调用方自己 parse 并处理失败。
 */
export interface DirectProviderToolCall { readonly id: string; readonly name: string; readonly arguments: string; }

export interface DirectProviderMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly images?: readonly DirectProviderImage[];
  /** role 为 tool 时必填：对应哪一次调用。 */
  readonly toolCallId?: string;
  /** role 为 assistant 且本轮发起过调用时，原样回传上游的 tool_calls 数组。 */
  readonly toolCalls?: readonly unknown[];
}

export const DIRECT_PROVIDER_MAX_CONTEXT_CHARS = 1_000_000;
export const DIRECT_PROVIDER_MAX_MESSAGES = 200;

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
  kind: 'text' | 'reasoning' | 'tool-call-start' | 'tool-calls' | 'done' | 'error';
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

/**
 * 解析原生侧在流末一次性交付的完整调用列表。
 * 这里刻意宽容：某一条调用长得不对就丢掉这一条，而不是让整轮对话崩掉——
 * 模型少调一个工具只是能力退化，整轮失败才是用户体验事故。
 */
function parseToolCalls(serialized: string): readonly DirectProviderToolCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown): readonly DirectProviderToolCall[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { id, name, arguments: args } = entry as { id?: unknown; name?: unknown; arguments?: unknown };
    if (typeof id !== 'string' || !id.trim() || typeof name !== 'string' || !name.trim()) return [];
    // 上游偶尔直接给对象而不是 JSON 文本，统一归一成字符串，让下游只有一种形态要处理。
    const text = typeof args === 'string' ? args : args === undefined ? '{}' : JSON.stringify(args);
    return [{ id: id.trim(), name: name.trim(), arguments: text }];
  });
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

  async stream(input: {
    providerId: string;
    messages: readonly DirectProviderMessage[];
    model?: string;
    /** 声明给模型的可调用工具；Anthropic-compatible 连接上会被原生侧忽略并退回无工具行为。 */
    tools?: readonly DirectProviderTool[];
    onText(text: string): void;
    onReasoning?(text: string): void;
    /** 模型刚开始发起某次调用时触发，参数是工具名；此时 arguments 通常还没收完。 */
    onToolCallStart?(name: string): void;
  }): Promise<{ model?: string; toolCalls: readonly DirectProviderToolCall[] }> {
    const providerId = requireIdentifier(input.providerId, 'providerId');
    if (input.messages.length === 0 || input.messages.length > DIRECT_PROVIDER_MAX_MESSAGES) throw new Error('当前会话历史无效或过长');
    const messages = input.messages.map((message) => {
      const content = message.content.trim();
      // 两种消息允许没有正文：工具结果（可能真的什么都没返回），
      // 以及只发起工具调用、一句话都没说的那一轮 assistant。
      const allowsEmptyContent = message.role === 'tool' || (message.role === 'assistant' && Boolean(message.toolCalls?.length));
      if (!['user', 'assistant', 'tool'].includes(message.role) || (!allowsEmptyContent && !content) || content.length > DIRECT_PROVIDER_MAX_CONTEXT_CHARS) throw new Error('会话消息无效');
      if (message.role === 'tool' && !message.toolCallId?.trim()) throw new Error('工具结果缺少对应的调用标识');
      const images = (message.images ?? []).map((image) => {
        if (!/^image\/(png|jpeg|webp|gif|bmp)$/i.test(image.mediaType) || !/^[A-Za-z0-9+/=]+$/.test(image.base64Data) || image.base64Data.length > 50 * 1024 * 1024) throw new Error('图片附件无效或超过供应商 Base64 上限');
        return { mediaType: image.mediaType, base64Data: image.base64Data };
      });
      return {
        role: message.role,
        content,
        ...(images.length ? { images } : {}),
        ...(message.role === 'tool' ? { toolCallId: message.toolCallId?.trim() } : {}),
        ...(message.role === 'assistant' && message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      };
    });
    if (messages.reduce((length, message) => length + message.content.length, 0) > DIRECT_PROVIDER_MAX_CONTEXT_CHARS) throw new Error('当前会话上下文超过 1M 字符预算；请缩小附件或新建对话后重试');
    if (input.model !== undefined) requireModelIdentifier(input.model);
    const tools = (input.tools ?? []).map((tool) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || !tool.description.trim() || typeof tool.parameters !== 'object' || tool.parameters === null || Array.isArray(tool.parameters)) throw new Error('工具声明无效');
      return { name: tool.name, description: tool.description.trim(), parameters: tool.parameters };
    });
    const id = requestId();
    let unlisten: UnlistenFn | undefined;
    return new Promise<{ model?: string; toolCalls: readonly DirectProviderToolCall[] }>((resolve, reject) => {
      let collected: readonly DirectProviderToolCall[] = [];
      const finish = (result: { model?: string; toolCalls: readonly DirectProviderToolCall[] } | Error): void => {
        unlisten?.();
        result instanceof Error ? reject(result) : resolve(result);
      };
      void listen<NativeStreamEvent>('direct-provider-stream', (event) => {
        const payload = event.payload;
        if (!payload || payload.requestId !== id) return;
        if (payload.kind === 'text' && typeof payload.text === 'string') { input.onText(payload.text); return; }
        if (payload.kind === 'reasoning' && typeof payload.text === 'string') { input.onReasoning?.(payload.text); return; }
        if (payload.kind === 'tool-call-start' && typeof payload.text === 'string') { input.onToolCallStart?.(payload.text); return; }
        if (payload.kind === 'tool-calls' && typeof payload.message === 'string') { collected = parseToolCalls(payload.message); return; }
        if (payload.kind === 'done') { finish({ ...(typeof payload.model === 'string' ? { model: payload.model } : {}), toolCalls: collected }); return; }
        if (payload.kind === 'error') { finish(new Error(typeof payload.message === 'string' ? payload.message : '第三方模型请求未完成')); }
      }).then((dispose) => {
        unlisten = dispose;
        return invoke('start_direct_provider_stream', { request: { providerId, messages, ...(tools.length ? { tools } : {}), ...(input.model?.trim() ? { model: input.model.trim() } : {}), requestId: id } });
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error('无法启动第三方模型请求')));
    });
  }
}

export const directProviderClient = new DirectProviderClient();
