// 一个文件=一种作用：远端目录同步（fetch 由调用方注入，本层不持有任何全局传输）。

import { isProviderProtocol, type ModelOptionSpec, type ModelOptionSpecs, type ProviderDefinition, type ProviderModelDefinition } from '../config/index.js';
import { CatalogSyncError, type CatalogFetcher, type RemoteCatalogSnapshot } from './types.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface RemoteProviderCatalogOptions {
  /** 远端目录地址；本层不推导、不拼接。 */
  readonly url: string;
  /** 注入的抓取器。生产用 `globalThis.fetch`，测试用替身，永不隐式出网。 */
  readonly fetcher: CatalogFetcher;
  /** 时钟注入，便于测试与稳定快照。 */
  readonly now?: () => number;
}

/**
 * 远端 provider 目录：负责「取回来 + 校验 + 冻结成快照」。
 * 不写磁盘、不读环境变量；物化交给 `materializeRemoteCatalog`。
 */
export class RemoteProviderCatalog {
  readonly #url: string;
  readonly #fetcher: CatalogFetcher;
  readonly #now: () => number;
  #snapshot: RemoteCatalogSnapshot | undefined;

  constructor(options: RemoteProviderCatalogOptions) {
    this.#url = options.url;
    this.#fetcher = options.fetcher;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 最近一次成功同步的快照；从未成功过则为 undefined。 */
  current(): RemoteCatalogSnapshot | undefined {
    return this.#snapshot;
  }

  async sync(options: { readonly signal?: AbortSignal } = {}): Promise<RemoteCatalogSnapshot> {
    let response;
    try {
      response = await this.#fetcher(this.#url, options.signal ? { signal: options.signal } : {});
    } catch (error) {
      throw new CatalogSyncError(
        'catalog-network-error',
        `远端目录请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new CatalogSyncError('catalog-http-error', `远端目录返回 HTTP ${response.status}`, response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CatalogSyncError('catalog-invalid-payload', '远端目录响应不是合法 JSON');
    }

    const providers = readProviders(payload);
    const snapshot: RemoteCatalogSnapshot = Object.freeze({
      schemaVersion: 1 as const,
      revision: readRevision(payload),
      fetchedAt: this.#now(),
      providers: Object.freeze(providers.map((provider) => Object.freeze(provider))),
    });
    this.#snapshot = snapshot;
    return snapshot;
  }
}

function readRevision(payload: unknown): number {
  const revision = asRecord(payload).revision;
  return typeof revision === 'number' && Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
}

function readProviders(payload: unknown): readonly ProviderDefinition[] {
  const record = asRecord(payload);
  const providers = record.providers;
  if (!Array.isArray(providers)) {
    throw new CatalogSyncError('catalog-invalid-payload', '远端目录缺少 providers 数组');
  }
  // 任一记录不合法即整批作废：半截目录会把用户的连接静默改写坏，比同步失败更糟。
  return providers.map((provider, index) => normalizeProvider(provider, index));
}

function normalizeProvider(value: unknown, index: number): ProviderDefinition {
  const record = asRecord(value);
  const providerId = record.providerId;
  if (typeof providerId !== 'string' || !IDENTIFIER.test(providerId)) {
    throw new CatalogSyncError('catalog-invalid-payload', `远端目录第 ${index} 条记录的 providerId 非法`);
  }
  const providerName = record.providerName;
  if (typeof providerName !== 'string' || providerName.trim().length === 0) {
    throw new CatalogSyncError('catalog-invalid-payload', `远端目录 ${providerId} 缺少 providerName`);
  }
  if (!isProviderProtocol(record.protocol)) {
    throw new CatalogSyncError('catalog-invalid-payload', `远端目录 ${providerId} 的 protocol 不在闭集内`);
  }
  const defaultBaseUrl = record.defaultBaseUrl;
  if (typeof defaultBaseUrl !== 'string') {
    throw new CatalogSyncError('catalog-invalid-payload', `远端目录 ${providerId} 缺少 defaultBaseUrl`);
  }
  const defaultModel = record.defaultModel;
  if (typeof defaultModel !== 'string' || !MODEL_IDENTIFIER.test(defaultModel)) {
    throw new CatalogSyncError('catalog-invalid-payload', `远端目录 ${providerId} 的 defaultModel 非法`);
  }
  return {
    providerId,
    providerName: providerName.trim(),
    protocol: record.protocol,
    defaultBaseUrl,
    defaultModel,
    models: readModels(record.models, providerId),
  };
}

function readModels(value: unknown, providerId: string): readonly ProviderModelDefinition[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new CatalogSyncError('catalog-invalid-payload', `远端目录 ${providerId} 的 models 不是数组`);
  }
  return Object.freeze(
    value.map((entry, index) => {
      const record = asRecord(entry);
      const modelId = record.modelId;
      if (typeof modelId !== 'string' || !MODEL_IDENTIFIER.test(modelId)) {
        throw new CatalogSyncError(
          'catalog-invalid-payload',
          `远端目录 ${providerId} 第 ${index} 个模型标识非法`,
        );
      }
      const displayName = record.displayName;
      return {
        modelId,
        ...(typeof displayName === 'string' && displayName.trim().length > 0
          ? { displayName: displayName.trim() }
          : {}),
        optionSpecs: readOptionSpecs(record.optionSpecs, providerId, modelId),
      };
    }),
  );
}

function readOptionSpecs(value: unknown, providerId: string, modelId: string): ModelOptionSpecs {
  if (value === undefined) return Object.freeze({});
  const record = asRecord(value);
  const specs: Record<string, ModelOptionSpec> = {};
  for (const [name, entry] of Object.entries(record)) {
    const spec = asRecord(entry);
    if (typeof spec.map !== 'string') {
      throw new CatalogSyncError(
        'catalog-invalid-payload',
        `远端目录 ${providerId}/${modelId} 的选项 ${name} 缺少 map 模板`,
      );
    }
    const values = spec.values;
    if (values !== undefined && (!Array.isArray(values) || values.some((item) => typeof item !== 'string'))) {
      throw new CatalogSyncError(
        'catalog-invalid-payload',
        `远端目录 ${providerId}/${modelId} 的选项 ${name} 的 values 必须是字符串数组`,
      );
    }
    specs[name] = {
      map: spec.map,
      ...(values === undefined ? {} : { values: Object.freeze([...(values as string[])]) }),
      ...(typeof spec.defaultValue === 'string' ? { defaultValue: spec.defaultValue } : {}),
    };
  }
  return Object.freeze(specs);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
