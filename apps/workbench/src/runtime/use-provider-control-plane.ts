import { useCallback, useState } from 'react';
import type { WorkbenchProviderConnection, WorkbenchProviderConnectionProbe, WorkbenchProviderInference, WorkbenchProviderModelDiscovery } from './task-client';
import { directProviderClient, type DirectProviderConnection, type DirectProviderProtocol } from './direct-provider-client';

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
    'provider-request-failed': '第三方服务未响应。请检查网络、Base URL 与供应商服务状态。',
    'provider-model-list-failed': '第三方服务拒绝模型目录请求；仍可按供应商文档手动填写模型名称。',
    'provider-http-401': '第三方服务拒绝了 API key，请确认密钥、账号或套餐。',
    'provider-http-403': '第三方服务拒绝访问，请确认账号权限、套餐与模型可用性。',
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

  const configure = useCallback((providerId: string, input: { displayName?: string; model?: string; baseUrl?: string; protocol?: DirectProviderProtocol; apiKey: string }): void => {
    setPendingProviderId(providerId); setError(undefined);
    void directProviderClient.configure({ providerId, displayName: input.displayName?.trim() || providerId, protocol: input.protocol ?? 'openai-compatible', baseUrl: input.baseUrl ?? '', model: input.model ?? '', apiKey: input.apiKey })
      .then((result) => setConnections((current) => replaceConnection(current, asConnection(result))))
      .catch((nextError: unknown) => setError(errorMessage(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, []);

  const configureCustom = useCallback((input: { displayName: string; protocol: DirectProviderProtocol; baseUrl: string; model: string; apiKey: string }): void => {
    const providerId = customProviderId(input.displayName);
    setPendingProviderId('custom'); setError(undefined);
    void directProviderClient.configure({ providerId, ...input })
      .then((result) => setConnections((current) => replaceConnection(current, asConnection(result))))
      .catch((nextError: unknown) => setError(errorMessage(nextError)))
      .finally(() => setPendingProviderId(undefined));
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

  const probe = useCallback((providerId: string): void => discoverModels(providerId), [discoverModels]);

  const stream = useCallback((providerId: string, prompt: string, model?: string): void => {
    setPendingProviderId(providerId); setError(undefined);
    setStreaming((current) => ({ ...current, [providerId]: { output: '', ...(model ? { model } : {}), complete: false } }));
    void directProviderClient.stream({ providerId, prompt, model, onText: (text) => setStreaming((current) => {
      const previous = current[providerId] ?? { output: '', complete: false };
      return { ...current, [providerId]: { ...previous, output: previous.output + text } };
    }) })
      .then((completion) => setStreaming((current) => {
        const previous = current[providerId] ?? { output: '', complete: false };
        return { ...current, [providerId]: { ...previous, ...(completion.model ? { model: completion.model } : {}), outputCharacters: previous.output.length, complete: true } };
      }))
      .catch((nextError: unknown) => setError(errorMessage(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, []);

  const infer = useCallback((providerId: string, prompt: string, model?: string): void => {
    const startedAt = Date.now();
    setPendingProviderId(providerId); setError(undefined);
    const output: string[] = [];
    void directProviderClient.stream({ providerId, prompt, model, onText: (text) => output.push(text) })
      .then((completion) => setInferences((current) => ({ ...current, [providerId]: { schemaVersion: 1, providerId, profileId: `desktop-direct.${providerId}`, profileRevision: 1, model: completion.model ?? model ?? '', dataBoundary: 'remote-allowed', output: output.join(''), outputDigest: 'desktop-direct', outputCharacters: output.join('').length, latencyMs: Math.max(0, Date.now() - startedAt), canReadSecret: false, canAutoExecuteTools: false, canAutoConnect: false } })))
      .catch((nextError: unknown) => setError(errorMessage(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, []);

  const reset = useCallback((): void => { setConnections([]); setProbes({}); setDiscoveredModels({}); setInferences({}); setStreaming({}); setError(undefined); setPendingProviderId(undefined); }, []);
  const refresh = useCallback((): void => { setError(undefined); }, []);
  const unavailable = useCallback((providerId: string): void => setError(`${providerId} 已通过桌面直接连接；无需登记或激活步骤。`), []);

  return { connections, probes, discoveredModels, inferences, streaming, error, pendingProviderId, reset, refresh, configure, configureCustom, register: unavailable, activate: unavailable, probe, discoverModels, infer, stream };
}
