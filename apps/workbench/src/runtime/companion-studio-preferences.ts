export type CompanionStudioSection = 'service-sources' | 'body-modules' | 'character-models' | 'character-cards' | 'companion-system';
export type CompanionServiceSource = 'chat' | 'speech' | 'transcription' | 'artistry';
export type CompanionBodyModule = 'consciousness' | 'voice' | 'hearing' | 'vision' | 'memory' | 'discord' | 'minecraft' | 'factorio' | 'mcp';

export interface CompanionStudioPreferencesV1 {
  readonly schemaVersion: 1;
  readonly services: Readonly<Record<CompanionServiceSource, boolean>>;
  readonly modules: Readonly<Record<CompanionBodyModule, boolean>>;
  readonly modelSlots: Readonly<{ live2d: boolean; vrm: boolean }>;
  readonly activeCharacterCardId: 'orbit' | 'mori' | 'pixel' | 'sage';
  readonly desktopResidencyMode: 'disabled' | 'windows-native';
}

const STORAGE_KEY = 'awo.companion.studio-preferences.v1';
const SERVICES: readonly CompanionServiceSource[] = ['chat', 'speech', 'transcription', 'artistry'];
const MODULES: readonly CompanionBodyModule[] = ['consciousness', 'voice', 'hearing', 'vision', 'memory', 'discord', 'minecraft', 'factorio', 'mcp'];

export const DEFAULT_COMPANION_STUDIO_PREFERENCES: CompanionStudioPreferencesV1 = Object.freeze({
  schemaVersion: 1,
  services: Object.freeze({ chat: true, speech: true, transcription: true, artistry: true }),
  modules: Object.freeze({ consciousness: true, voice: true, hearing: true, vision: true, memory: true, discord: true, minecraft: true, factorio: true, mcp: true }),
  modelSlots: Object.freeze({ live2d: true, vrm: true }),
  activeCharacterCardId: 'orbit',
  desktopResidencyMode: 'disabled',
});

function record<T extends string>(value: unknown, keys: readonly T[], fallback: Readonly<Record<T, boolean>>): Readonly<Record<T, boolean>> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, typeof source[key] === 'boolean' ? source[key] : fallback[key]])) as Record<T, boolean>);
}

/** 只存跨端的无秘密配置意图；真实 API、音频、模型资产、导入文件和模块权限均不进入此对象。 */
export function parseCompanionStudioPreferences(value: unknown): CompanionStudioPreferencesV1 {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    schemaVersion: 1,
    services: record(source.services, SERVICES, DEFAULT_COMPANION_STUDIO_PREFERENCES.services),
    modules: record(source.modules, MODULES, DEFAULT_COMPANION_STUDIO_PREFERENCES.modules),
    modelSlots: record(source.modelSlots, ['live2d', 'vrm'], DEFAULT_COMPANION_STUDIO_PREFERENCES.modelSlots),
    activeCharacterCardId: source.activeCharacterCardId === 'mori' || source.activeCharacterCardId === 'pixel' || source.activeCharacterCardId === 'sage' ? source.activeCharacterCardId : 'orbit',
    desktopResidencyMode: source.desktopResidencyMode === 'windows-native' ? 'windows-native' : 'disabled',
  };
}

export function loadCompanionStudioPreferences(storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): CompanionStudioPreferencesV1 {
  if (!storage) return DEFAULT_COMPANION_STUDIO_PREFERENCES;
  try { const saved = storage.getItem(STORAGE_KEY); return saved ? parseCompanionStudioPreferences(JSON.parse(saved)) : DEFAULT_COMPANION_STUDIO_PREFERENCES; } catch { return DEFAULT_COMPANION_STUDIO_PREFERENCES; }
}

export function saveCompanionStudioPreferences(preferences: CompanionStudioPreferencesV1, storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function updateCompanionStudioPreferences(current: CompanionStudioPreferencesV1, change: Partial<CompanionStudioPreferencesV1>): CompanionStudioPreferencesV1 {
  return parseCompanionStudioPreferences({ ...current, ...change });
}
