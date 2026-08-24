import { useCallback, useState } from 'react';
import { useEffect } from 'react';
import type { WorkbenchProviderConnection, WorkbenchProviderConnectionProbe, WorkbenchProviderInference, WorkbenchProviderModelDiscovery } from './task-client';
import { directProviderClient, type DirectProviderConnection, type DirectProviderProtocol } from './direct-provider-client';
import { loadDirectProviderAccounts, saveDirectProviderAccount } from './direct-provider-accounts';
import { createProviderTraceId, recordProviderDiagnostic } from './provider-diagnostics';

export type ProviderErrorText = (error: unknown) => string;

export interface WorkbenchProviderStreamingOutput {
  readonly output: string;
  readonly model?: string;
  readonly outputCharacters?: number;
  readonly complete: boolean;
}

export interface ProviderControlPlane {
  readonly connections: readonly WorkbenchProviderConnection[];
  readonly probes: Readonly<Record<string, WorkbenchProviderConnectionProbe | undefined>>;
  readonly discoveredModels: Readonly<Record<string, WorkbenchProviderModelDiscovery | undefined>>;
  readonly inferences: Readonly<Record<string, WorkbenchProviderInference | undefined>>;
  readonly streaming: Readonly<Record<string, WorkbenchProviderStreamingOutput | undefined>>;
  readonly error: string | undefined;
  readonly pendingProviderId: string | undefined;
  readonly restoring: boolean;
  reset(): void;
  refresh(): void;
  configure(providerId: string, input: { displayName?: string; model?: string; baseUrl?: string; protocol?: DirectProviderProtocol; apiKey: string }): void;
  configureCustom(input: { displayName: string; protocol: DirectProviderProtocol; baseUrl: string; model: string; apiKey: string }): void;
  register(providerId: string): void;
  activate(providerId: string): void;
  probe(providerId: string): void;
  discoverModels(providerId: string): void;
  infer(providerId: string, prompt: string, model?: string): void;
  stream(providerId: string, prompt: string, model?: string): void;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const mapping: Record<string, string> = {
    'provider-not-connected': '此模型尚未连接，请先在模型设置页填写地址、密钥和模型名称。',
    'provider-request-failed': '第三方请求未完成，但未得到可分类的网络错误。请复制“已连接模型”中的本地诊断报告。',
    'provider-connect-failed': '已找到 Provider 域名，但无法建立 HTTPS 连接。请检查网络、防火墙、代理或 Base URL。',
    'provider-dns-failed': '无法解析 Provider 域名。请检查 Base URL、DNS 或网络连接。',
    'provider-tls-failed': 'Provider HTTPS 证书或 TLS 协商失败。请检查系统时间、证书链、代理或网络检查软件。',
    'provider-connect-timeout': '连接 Provider 超时。请检查网络、代理、Base URL 或供应商状态。',
    'provider-request-timeout': 'Provider 请求等待超时。请检查网络、模型服务负载或缩短本轮上下文后重试。',
    'provider-request-invalid': '桌面端无法构造当前 Provider 请求。请重新保存协议、Base URL、模型与密钥后重试。',
    'provider-stream-failed': '第三方服务已建立响应但流式传输中断；请检查模型、上下文长度、网络或供应商状态。',
    'provider-client-unavailable': '桌面端无法创建第三方模型 HTTP 客户端；请重启应用后重试。',
    'provider-model-list-failed': '第三方服务拒绝模型目录请求；仍可按供应商文档手动填写模型名称。',
    'provider-http-401': '第三方服务拒绝了 API key，请确认密钥、账号或套餐。',
    'provider-http-403': '第三方服务拒绝访问，请确认账号权限、套餐与模型可用性。',
    'provider-http-429': '第三方服务暂时限流，请稍后重试。',
    'provider-request-rejected': '第三方服务拒绝了当前协议、地址、模型或请求参数；请按供应商文档核对后重试。',
  };
  return mapping[message] ?? (message && !/[<{]/.test(message) ? message : '第三方模型请求未完成。');
}

function asConnection(connection: DirectProviderConnection): WorkbenchProviderConnection {
  return {
    schemaVersion: 1, providerId: connection.providerId, displayName: connection.displayName,
    driverId: `desktop-direct.${connection.protocol}`, defaultModel: connection.defaultModel,
    credentialReference: 'native-session', credentialAvailability: 'available', profileStatus: 'active', profileRevision: 1,
    canReadSecret: false, canAutoConnect: false,
  };
}

function replaceConnection(current: readonly WorkbenchProviderConnection[], connection: WorkbenchProviderConnection): readonly WorkbenchProviderConnection[] {
  return [...current.filter((item) => item.providerId !== connection.providerId), connection].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function customProviderId(displayName: string): string {
  const normalized = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'provider';
  return `custom-${normalized}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** 直接 Provider 控制面：配置和 key 经 Tauri invoke 进入原生内存；浏览器不请求本机 HTTP 服务。 */
export function useProviderControlPlane(): ProviderControlPlane {
  const [connections, setConnections] = useState<readonly WorkbenchProviderConnection[]>([]);
  const [probes, setProbes] = useState<Readonly<Record<string, WorkbenchProviderConnectionProbe | undefined>>>({});
  const [discoveredModels, setDiscoveredModels] = useState<Readonly<Record<string, WorkbenchProviderModelDiscovery | undefined>>>({});
  const [inferences, setInferences] = useState<Readonly<Record<string, WorkbenchProviderInference | undefined>>>({});
  const [streaming, setStreaming] = useState<Readonly<Record<string, WorkbenchProviderStreamingOutput | undefined>>>({});
  const [error, setError] = useState<string>();
  const [pendingProviderId, setPendingProviderId] = useState<string>();
  const [restoring, setRestoring] = useState(() => typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) && loadDirectProviderAccounts().length > 0);

  useEffect(() => {
    const accounts = loadDirectProviderAccounts();
    const nativeRuntime = typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!nativeRuntime || accounts.length === 0) { setRestoring(false); return; }
    let disposed = false;
    void Promise.allSettled(accounts.map((account) => directProviderClient.configure(account))).then((results) => {
      if (disposed) return;
      const restored = results.flatMap((result) => result.status === 'fulfilled' ? [asConnection(result.value)] : []);
      if (restored.length > 0) setConnections((current) => restored.reduce((next, connection) => replaceConnection(next, connection), current));
      if (restored.length !== accounts.length) setError('部分已保存模型无法恢复到桌面原生会话；请在 API 连接中重新连接该模型。');
    }).finally(() => { if (!disposed) setRestoring(false); });
    return () => { disposed = true; };
  }, []);

  const configure = useCallback((providerId: string, input: { displayName?: string; model?: string; baseUrl?: string; protocol?: DirectProviderProtocol; apiKey: string }): void => {
    const startedAt = Date.now();
    const traceId = createProviderTraceId();
    let configured = false;
    let probeStartedAt = startedAt;
    setPendingProviderId(providerId); setError(undefined);
    void (async () => {
      const result = await directProviderClient.configure({ providerId, displayName: input.displayName?.trim() || providerId, protocol: input.protocol ?? 'openai-compatible', baseUrl: input.baseUrl ?? '', model: input.model ?? '', apiKey: input.apiKey });
      saveDirectProviderAccount({ schemaVersion: 1, providerId: result.providerId, displayName: result.displayName, protocol: result.protocol, baseUrl: input.baseUrl ?? '', model: result.defaultModel, apiKey: input.apiKey });
      setConnections((current) => replaceConnection(current, asConnection(result)));
      recordProviderDiagnostic({ providerId, model: result.defaultModel, stage: 'configured', outcome: 'succeeded', startedAt, traceId });
      configured = true;
      probeStartedAt = Date.now();
      await directProviderClient.probe(providerId);
      const checkedAt = Date.now();
      setProbes((current) => ({ ...current, [providerId]: { schemaVersion: 1, providerId, outcome: 'reachable', checkedAt, canReadSecret: false, canAutoConnect: false } }));
      recordProviderDiagnostic({ providerId, model: result.defaultModel, stage: 'probe', outcome: 'succeeded', startedAt: probeStartedAt, traceId });
    })().catch((nextError: unknown) => { recordProviderDiagnostic({ providerId, model: input.model, stage: configured ? 'probe' : 'configured', outcome: 'failed', startedAt: configured ? probeStartedAt : startedAt, error: nextError, traceId }); setError(errorMessage(nextError)); }).finally(() => setPendingProviderId(undefined));
  }, []);

  const configureCustom = useCallback((input: { displayName: string; protocol: DirectProviderProtocol; baseUrl: string; model: string; apiKey: string }): void => {
    const providerId = customProviderId(input.displayName);
    const startedAt = Date.now();
    const traceId = createProviderTraceId();
    let configured = false;
    let probeStartedAt = startedAt;
    setPendingProviderId('custom'); setError(undefined);
    void (async () => {
      const result = await directProviderClient.configure({ providerId, ...input });
      saveDirectProviderAccount({ schemaVersion: 1, providerId: result.providerId, displayName: result.displayName, protocol: result.protocol, baseUrl: input.baseUrl, model: result.defaultModel, apiKey: input.apiKey });
      setConnections((current) => replaceConnection(current, asConnection(result)));
      recordProviderDiagnostic({ providerId: result.providerId, model: result.defaultModel, stage: 'configured', outcome: 'succeeded', startedAt, traceId });
      configured = true;
      probeStartedAt = Date.now();
      await directProviderClient.probe(result.providerId);
      const checkedAt = Date.now();
      setProbes((current) => ({ ...current, [result.providerId]: { schemaVersion: 1, providerId: result.providerId, outcome: 'reachable', checkedAt, canReadSecret: false, canAutoConnect: false } }));
      recordProviderDiagnostic({ providerId: result.providerId, model: result.defaultModel, stage: 'probe', outcome: 'succeeded', startedAt: probeStartedAt, traceId });
    })().catch((nextError: unknown) => { recordProviderDiagnostic({ providerId, model: input.model, stage: configured ? 'probe' : 'configured', outcome: 'failed', startedAt: configured ? probeStartedAt : startedAt, error: nextError, traceId }); setError(errorMessage(nextError)); }).finally(() => setPendingProviderId(undefined));
  }, []);

  const discoverModels = useCallback((providerId: string): void => {
    setPendingProviderId(providerId); setError(undefined);
    const checkedAt = Date.now();
    void directProviderClient.discover(providerId)
      .then((models) => {
        const result: WorkbenchProviderModelDiscovery = { schemaVersion: 1, providerId, outcome: 'reachable', checkedAt, models, canReadSecret: false, canAutoConnect: false };
        setDiscoveredModels((current) => ({ ...current, [providerId]: result }));
        setProbes((current) => ({ ...current, [providerId]: result }));
      })
      .catch((nextError: unknown) => {
        setProbes((current) => ({ ...current, [providerId]: { schemaVersion: 1, providerId, outcome: 'unreachable', checkedAt, canReadSecret: false, canAutoConnect: false } }));
        setError(errorMessage(nextError));
      })
      .finally(() => setPendingProviderId(undefined));
  }, []);

  const probe = useCallback((providerId: string): void => {
    const startedAt = Date.now();
    const traceId = createProviderTraceId();
    setPendingProviderId(providerId); setError(undefined);
    const checkedAt = Date.now();
    void directProviderClient.probe(providerId)
      .then(() => { recordProviderDiagnostic({ providerId, stage: 'probe', outcome: 'succeeded', startedAt, traceId }); setProbes((current) => ({ ...current, [providerId]: { schemaVersion: 1, providerId, outcome: 'reachable', checkedAt, canReadSecret: false, canAutoConnect: false } })); })
      .catch((nextError: unknown) => {
        recordProviderDiagnostic({ providerId, stage: 'probe', outcome: 'failed', startedAt, error: nextError, traceId });
        setProbes((current) => ({ ...current, [providerId]: { schemaVersion: 1, providerId, outcome: 'unreachable', checkedAt, canReadSecret: false, canAutoConnect: false } }));
        setError(errorMessage(nextError));
      })
      .finally(() => setPendingProviderId(undefined));
  }, []);

  const stream = useCallback((providerId: string, prompt: string, model?: string): void => {
    const startedAt = Date.now();
    const traceId = createProviderTraceId();
    let firstByteAt: number | undefined;
    setPendingProviderId(providerId); setError(undefined);
    setStreaming((current) => ({ ...current, [providerId]: { output: '', ...(model ? { model } : {}), complete: false } }));
    void directProviderClient.stream({ providerId, messages: [{ role: 'user', content: prompt }], model, onText: (text) => { firstByteAt ??= Date.now(); setStreaming((current) => {
      const previous = current[providerId] ?? { output: '', complete: false };
      return { ...current, [providerId]: { ...previous, output: previous.output + text } };
    }); } })
      .then((completion) => { recordProviderDiagnostic({ providerId, model: completion.model ?? model, stage: 'stream-test', outcome: 'succeeded', startedAt, firstByteAt, traceId }); setStreaming((current) => {
        const previous = current[providerId] ?? { output: '', complete: false };
        return { ...current, [providerId]: { ...previous, ...(completion.model ? { model: completion.model } : {}), outputCharacters: previous.output.length, complete: true } };
      }); })
      .catch((nextError: unknown) => { recordProviderDiagnostic({ providerId, model, stage: 'stream-test', outcome: 'failed', startedAt, error: nextError, traceId }); setError(errorMessage(nextError)); })
      .finally(() => setPendingProviderId(undefined));
  }, []);

  const infer = useCallback((providerId: string, prompt: string, model?: string): void => {
    const startedAt = Date.now();
    setPendingProviderId(providerId); setError(undefined);
    const output: string[] = [];
    void directProviderClient.stream({ providerId, messages: [{ role: 'user', content: prompt }], model, onText: (text) => output.push(text) })
      .then((completion) => setInferences((current) => ({ ...current, [providerId]: { schemaVersion: 1, providerId, profileId: `desktop-direct.${providerId}`, profileRevision: 1, model: completion.model ?? model ?? '', dataBoundary: 'remote-allowed', output: output.join(''), outputDigest: 'desktop-direct', outputCharacters: output.join('').length, latencyMs: Math.max(0, Date.now() - startedAt), canReadSecret: false, canAutoExecuteTools: false, canAutoConnect: false } })))
      .catch((nextError: unknown) => setError(errorMessage(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, []);

  const reset = useCallback((): void => { setConnections([]); setProbes({}); setDiscoveredModels({}); setInferences({}); setStreaming({}); setError(undefined); setPendingProviderId(undefined); }, []);
  const refresh = useCallback((): void => { setError(undefined); }, []);
  const unavailable = useCallback((providerId: string): void => setError(`${providerId} 已通过桌面直接连接；无需登记或激活步骤。`), []);

  return { connections, probes, discoveredModels, inferences, streaming, error, pendingProviderId, restoring, reset, refresh, configure, configureCustom, register: unavailable, activate: unavailable, probe, discoverModels, infer, stream };
}
