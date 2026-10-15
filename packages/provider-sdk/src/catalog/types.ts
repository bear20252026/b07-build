// 一个文件=一种作用：远端目录层的注入式传输契约（只声明最小面，不绑定具体 fetch 实现）。

import type { ProviderDefinition } from '../config/index.js';

/** 远端目录层真正用到的最小响应面：状态、成功标志、JSON 读取。 */
export interface CatalogFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * 目录抓取器。生产环境传 `globalThis.fetch`，测试传不出网的替身。
 * 之所以显式声明而不是直接依赖 `typeof fetch`：本层必须能在没有 DOM/Node 类型的环境里被替身驱动。
 */
export type CatalogFetcher = (
  url: string,
  init: { readonly signal?: AbortSignal },
) => Promise<CatalogFetchResponse>;

export type CatalogSyncErrorCode =
  | 'catalog-network-error'
  | 'catalog-http-error'
  | 'catalog-invalid-payload';

export class CatalogSyncError extends Error {
  readonly code: CatalogSyncErrorCode;
  readonly status?: number;

  constructor(code: CatalogSyncErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'CatalogSyncError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** 目录快照：一次成功同步的产物，物化时作为唯一输入。 */
export interface RemoteCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly fetchedAt: number;
  readonly providers: readonly ProviderDefinition[];
}
