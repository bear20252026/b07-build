import { useCallback, useEffect, useState } from 'react';
import {
  HttpWorkbenchTaskClient,
  type WorkbenchProviderConnection,
  type WorkbenchProviderConnectionProbe,
  type WorkbenchProviderInference,
} from './task-client';

export type ProviderErrorText = (error: unknown) => string;

export interface ProviderControlPlane {
  readonly connections: readonly WorkbenchProviderConnection[] | undefined;
  readonly probes: Readonly<Record<string, WorkbenchProviderConnectionProbe | undefined>>;
  readonly inferences: Readonly<Record<string, WorkbenchProviderInference | undefined>>;
  readonly error: string | undefined;
  readonly pendingProviderId: string | undefined;
  hydrateConnections(connections: readonly WorkbenchProviderConnection[]): void;
  reset(): void;
  refresh(): void;
  configure(providerId: string, input: { displayName?: string; model?: string; apiKey: string }): void;
  configureCustom(input: { displayName: string; protocol: 'openai-compatible' | 'anthropic-compatible'; baseUrl: string; model: string; apiKey: string }): void;
  register(providerId: string): void;
  activate(providerId: string): void;
  probe(providerId: string): void;
  infer(providerId: string, prompt: string, model?: string): void;
}

function replaceConnection(
  current: readonly WorkbenchProviderConnection[] | undefined,
  connection: WorkbenchProviderConnection,
): readonly WorkbenchProviderConnection[] {
  return [...(current ?? []).filter((item) => item.providerId !== connection.providerId), connection]
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/**
 * Provider 控制面只经本机 Gateway client 调用。API key 从表单到 session-only Gateway，
 * 不进入 React state、任务事件、SQLite DTO 或本 hook 的返回值。
 */
export function useProviderControlPlane(
  gatewayAttached: boolean,
  errorText: ProviderErrorText,
  client = HttpWorkbenchTaskClient.forLocalGateway(),
): ProviderControlPlane {
  const [connections, setConnections] = useState<readonly WorkbenchProviderConnection[]>();
  const [probes, setProbes] = useState<Readonly<Record<string, WorkbenchProviderConnectionProbe | undefined>>>({});
  const [inferences, setInferences] = useState<Readonly<Record<string, WorkbenchProviderInference | undefined>>>({});
  const [error, setError] = useState<string>();
  const [pendingProviderId, setPendingProviderId] = useState<string>();

  const requireGateway = useCallback((): boolean => {
    if (gatewayAttached) return true;
    setError('请先显式附着本机 Gateway。');
    return false;
  }, [gatewayAttached]);

  const refresh = useCallback((): void => {
    if (!requireGateway()) return;
    setError(undefined);
    void client.providerConnections()
      .then(setConnections)
      .catch((nextError: unknown) => setError(errorText(nextError)));
  }, [client, errorText, requireGateway]);

  useEffect(() => {
    if (!gatewayAttached) return;
    let disposed = false;
    void client.providerConnections()
      .then((items) => { if (!disposed) setConnections(items); })
      .catch((nextError: unknown) => { if (!disposed) setError(errorText(nextError)); });
    return () => { disposed = true; };
  }, [client, errorText, gatewayAttached]);

  const configure = useCallback((providerId: string, input: { displayName?: string; model?: string; apiKey: string }): void => {
    if (!requireGateway()) return;
    setPendingProviderId(providerId);
    setError(undefined);
    void client.configureProviderSession(providerId, input)
      .then(async (connection) => {
        setConnections((current) => replaceConnection(current, connection));
        try {
          const probe = await client.probeProviderConnection(connection.providerId);
          setProbes((current) => ({ ...current, [connection.providerId]: probe }));
          if (probe.outcome !== 'reachable') setError(`连接已保存，但测试未通过：${probe.outcome}`);
        } catch (nextError) {
          setError(`连接已保存，但测试未完成：${errorText(nextError)}`);
        }
      })
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, [client, errorText, requireGateway]);

  const configureCustom = useCallback((input: { displayName: string; protocol: 'openai-compatible' | 'anthropic-compatible'; baseUrl: string; model: string; apiKey: string }): void => {
    if (!requireGateway()) return;
    setPendingProviderId('custom');
    setError(undefined);
    void client.configureCustomProviderSession(input)
      .then(async (connection) => {
        setConnections((current) => replaceConnection(current, connection));
        try {
          const probe = await client.probeProviderConnection(connection.providerId);
          setProbes((current) => ({ ...current, [connection.providerId]: probe }));
          if (probe.outcome !== 'reachable') setError(`连接已保存，但测试未通过：${probe.outcome}`);
        } catch (nextError) {
          setError(`连接已保存，但测试未完成：${errorText(nextError)}`);
        }
      })
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, [client, errorText, requireGateway]);

  const register = useCallback((providerId: string): void => {
    if (!requireGateway()) return;
    setPendingProviderId(providerId);
    setError(undefined);
    void client.registerProviderConnection(providerId, 'desktop-owner', 'Workbench explicit registration.')
      .then((connection) => setConnections((current) => replaceConnection(current, connection)))
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, [client, errorText, requireGateway]);

  const activate = useCallback((providerId: string): void => {
    if (!requireGateway()) return;
    setPendingProviderId(providerId);
    setError(undefined);
    void client.activateProviderConnection(providerId, 'desktop-owner', 'Workbench explicit activation; no automatic model call.')
      .then((connection) => setConnections((current) => replaceConnection(current, connection)))
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, [client, errorText, requireGateway]);

  const probe = useCallback((providerId: string): void => {
    if (!requireGateway()) return;
    setPendingProviderId(providerId);
    setError(undefined);
    void client.probeProviderConnection(providerId)
      .then((result) => setProbes((current) => ({ ...current, [providerId]: result })))
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, [client, errorText, requireGateway]);

  const infer = useCallback((providerId: string, prompt: string, model?: string): void => {
    if (!requireGateway()) return;
    setPendingProviderId(providerId);
    setError(undefined);
    void client.inferProviderConnection(providerId, prompt, model)
      .then((result) => setInferences((current) => ({ ...current, [providerId]: result })))
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPendingProviderId(undefined));
  }, [client, errorText, requireGateway]);

  const hydrateConnections = useCallback((items: readonly WorkbenchProviderConnection[]): void => {
    setConnections(items);
    setError(undefined);
  }, []);

  const reset = useCallback((): void => {
    setConnections(undefined);
    setProbes({});
    setInferences({});
    setError(undefined);
    setPendingProviderId(undefined);
  }, []);

  return { connections, probes, inferences, error, pendingProviderId, hydrateConnections, reset, refresh, configure, configureCustom, register, activate, probe, infer };
}
