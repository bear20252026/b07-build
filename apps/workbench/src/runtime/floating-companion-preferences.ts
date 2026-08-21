export type FloatingCompanionRoute = 'still' | 'harbor' | 'orbit';

export interface FloatingCompanionPreferencesV1 {
  readonly schemaVersion: 1;
  readonly x: number;
  readonly y: number;
  readonly route: FloatingCompanionRoute;
}

const STORAGE_KEY = 'awo.floating-companion.preferences.v1';
export const DEFAULT_FLOATING_COMPANION_PREFERENCES: FloatingCompanionPreferencesV1 = Object.freeze({ schemaVersion: 1, x: 86, y: 74, route: 'harbor' });

function coordinate(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(94, Math.max(6, value)) : fallback;
}

function route(value: unknown): FloatingCompanionRoute {
  return value === 'still' || value === 'orbit' ? value : 'harbor';
}

/** 仅保存跨设备可复用的应用内视觉位置与路线意图；不包含秘密、文件、桌面权限或原生窗口状态。 */
export function parseFloatingCompanionPreferences(value: unknown): FloatingCompanionPreferencesV1 {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { schemaVersion: 1, x: coordinate(source.x, DEFAULT_FLOATING_COMPANION_PREFERENCES.x), y: coordinate(source.y, DEFAULT_FLOATING_COMPANION_PREFERENCES.y), route: route(source.route) };
}

export function loadFloatingCompanionPreferences(storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): FloatingCompanionPreferencesV1 {
  if (!storage) return DEFAULT_FLOATING_COMPANION_PREFERENCES;
  try { const saved = storage.getItem(STORAGE_KEY); return saved ? parseFloatingCompanionPreferences(JSON.parse(saved)) : DEFAULT_FLOATING_COMPANION_PREFERENCES; } catch { return DEFAULT_FLOATING_COMPANION_PREFERENCES; }
}

export function saveFloatingCompanionPreferences(preferences: FloatingCompanionPreferencesV1, storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
