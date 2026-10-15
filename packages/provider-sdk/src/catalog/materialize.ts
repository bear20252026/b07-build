// 一个文件=一种作用：把远端目录快照物化成注册表可装载的定义集合（纯函数，零 IO）。

import { ProviderRegistry, type ProviderDefinition } from '../config/index.js';
import type { RemoteCatalogSnapshot } from './types.js';

export interface MaterializedCatalog {
  readonly definitions: readonly ProviderDefinition[];
  readonly registry: ProviderRegistry;
}

/**
 * 物化规则：以 `base`（通常是内置目录）为底，远端快照按 `providerId` 整条覆盖。
 * 刻意不做字段级合并——远端一条记录要么完整生效，要么完全不生效，
 * 否则「远端只改了 baseUrl」这类半截覆盖会让用户看到内置模型挂在远端地址上。
 */
export function materializeRemoteCatalog(input: {
  readonly base: readonly ProviderDefinition[];
  readonly snapshot: RemoteCatalogSnapshot;
}): MaterializedCatalog {
  const byId = new Map<string, ProviderDefinition>();
  for (const definition of input.base) byId.set(definition.providerId, definition);
  for (const definition of input.snapshot.providers) byId.set(definition.providerId, definition);
  const definitions = Object.freeze([...byId.values()]);
  return { definitions, registry: new ProviderRegistry(definitions) };
}
