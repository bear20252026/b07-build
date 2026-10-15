// 一个文件=一种作用：能力探测纯函数——把 provider 的能力集合归一成稳定的能力清单（零 IO）。
//
// 目的：调用方不必到处写 `in` / `instanceof` / 可选链来判断某能力在不在，
// 只需读一份清单；缺席的原因以稳定 reason 码给出，可直接展示。
// fail-closed：任何无法证实「在」的能力一律判为不可用，绝不猜成可用。

import {
  PROVIDER_CAPABILITY_IDS,
  type ProviderCapabilityFacets,
  type ProviderCapabilityId,
} from './facets.js';

/** 能力不可用的原因码。未知能力与缺席能力分开，便于区分「没有」与「问错了」。 */
export type ProviderCapabilityAbsenceReason =
  | 'provider-capability-absent'
  | 'provider-capability-unknown';

/** 清单里的一条能力状态；`reason` 仅在不可用时出现。 */
export interface ProviderCapabilityEntry {
  readonly capability: ProviderCapabilityId;
  readonly available: boolean;
  readonly reason?: ProviderCapabilityAbsenceReason;
}

/** 稳定的能力清单：顺序固定，与输入对象的键顺序无关。 */
export interface ProviderCapabilityManifest {
  readonly capabilities: readonly ProviderCapabilityEntry[];
}

/** 按任意字符串查询能力的结果；未登记 id 会原样回显。 */
export interface ProviderCapabilityLookup {
  readonly capability: string;
  readonly available: boolean;
  readonly reason?: ProviderCapabilityAbsenceReason;
}

/** 面级能力 id ↔ 能力面字段名的对应关系。 */
const FACET_CAPABILITIES: readonly {
  readonly id: ProviderCapabilityId;
  readonly key: keyof ProviderCapabilityFacets;
}[] = [
  { id: 'model-catalog', key: 'models' },
  { id: 'auth', key: 'auth' },
  { id: 'sessions', key: 'sessions' },
  { id: 'mcp', key: 'mcp' },
  { id: 'skills', key: 'skills' },
  { id: 'runtime', key: 'runtime' },
  { id: 'fork', key: 'fork' },
  { id: 'synchronizer', key: 'synchronizer' },
];

/**
 * 探测一个 provider 的能力集合，产出稳定清单。
 * 传入 undefined（或字段为 null）时全部判为不可用——缺席即不可用。
 */
export function probeProviderCapabilities(
  facets?: ProviderCapabilityFacets | undefined,
): ProviderCapabilityManifest {
  const source: ProviderCapabilityFacets = facets ?? {};
  const availability = new Map<ProviderCapabilityId, boolean>();
  for (const { id, key } of FACET_CAPABILITIES) {
    availability.set(id, isObjectLike(source[key]));
  }
  // 面内可选方法导出的细粒度能力：面在、方法不在，则该细粒度能力仍不可用。
  availability.set('runtime-background-work', hasMethod(source.runtime, 'listBackgroundWork'));
  availability.set('session-edit-anchor', hasMethod(source.sessions, 'resolveEditAnchor'));

  const capabilities = PROVIDER_CAPABILITY_IDS.map((capability) =>
    entry(capability, availability.get(capability) === true),
  );
  return Object.freeze({ capabilities: Object.freeze(capabilities) });
}

/** 查询清单里某能力的状态；未登记的 id 一律 fail-closed 为不可用。 */
export function resolveProviderCapability(
  manifest: ProviderCapabilityManifest,
  capability: string,
): ProviderCapabilityLookup {
  const found = manifest.capabilities.find((item) => item.capability === capability);
  if (!found) {
    return Object.freeze({ capability, available: false, reason: 'provider-capability-unknown' });
  }
  return found.reason === undefined
    ? Object.freeze({ capability, available: found.available })
    : Object.freeze({ capability, available: found.available, reason: found.reason });
}

/** 便捷判定：清单里该能力是否可用（未登记 id 返回 false）。 */
export function isProviderCapabilityAvailable(
  manifest: ProviderCapabilityManifest,
  capability: string,
): boolean {
  return resolveProviderCapability(manifest, capability).available;
}

function entry(capability: ProviderCapabilityId, available: boolean): ProviderCapabilityEntry {
  return available
    ? Object.freeze({ capability, available: true })
    : Object.freeze({ capability, available: false, reason: 'provider-capability-absent' });
}

function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function hasMethod(owner: unknown, name: string): boolean {
  return isObjectLike(owner) && typeof (owner as Record<string, unknown>)[name] === 'function';
}
