export type CompanionVisualMode = 'two-dimensional' | 'three-dimensional';

export interface CompanionPreferencesV1 {
  readonly schemaVersion: 1;
  readonly visualEnabled: boolean;
  readonly visualMode: CompanionVisualMode;
  readonly voiceEnabled: boolean;
  readonly ttsProvider: 'mimo-v2.5-tts';
  readonly proactiveSpeechEnabled: boolean;
  readonly microphoneEnabled: false;
  readonly screenCaptureEnabled: false;
  readonly desktopAutomationEnabled: false;
  readonly gameControlEnabled: false;
  readonly backgroundServiceEnabled: false;
}

const STORAGE_KEY = 'awo.companion.preferences.v1';

export const DEFAULT_COMPANION_PREFERENCES: CompanionPreferencesV1 = {
  schemaVersion: 1,
  visualEnabled: true,
  visualMode: 'three-dimensional',
  voiceEnabled: false,
  ttsProvider: 'mimo-v2.5-tts',
  proactiveSpeechEnabled: false,
  microphoneEnabled: false,
  screenCaptureEnabled: false,
  desktopAutomationEnabled: false,
  gameControlEnabled: false,
  backgroundServiceEnabled: false,
};

function isVisualMode(value: unknown): value is CompanionVisualMode {
  return value === 'two-dimensional' || value === 'three-dimensional';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Companion 偏好只保存无秘密的本地阅读/开关状态。它不持有 API key、音频、文字、模型文件、
 * Provider endpoint 或任何可执行授权；网页端和桌面端可复用同一结构。
 */
export function parseCompanionPreferences(value: unknown): CompanionPreferencesV1 {
  if (!value || typeof value !== 'object') return DEFAULT_COMPANION_PREFERENCES;
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1) return DEFAULT_COMPANION_PREFERENCES;
  return {
    schemaVersion: 1,
    visualEnabled: bool(source.visualEnabled, DEFAULT_COMPANION_PREFERENCES.visualEnabled),
    visualMode: isVisualMode(source.visualMode) ? source.visualMode : DEFAULT_COMPANION_PREFERENCES.visualMode,
    voiceEnabled: bool(source.voiceEnabled, false),
    ttsProvider: 'mimo-v2.5-tts',
    proactiveSpeechEnabled: bool(source.proactiveSpeechEnabled, false),
    microphoneEnabled: false,
    screenCaptureEnabled: false,
    desktopAutomationEnabled: false,
    gameControlEnabled: false,
    backgroundServiceEnabled: false,
  };
}

export function loadCompanionPreferences(storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): CompanionPreferencesV1 {
  if (!storage) return DEFAULT_COMPANION_PREFERENCES;
  try {
    const saved = storage.getItem(STORAGE_KEY);
    return saved ? parseCompanionPreferences(JSON.parse(saved)) : DEFAULT_COMPANION_PREFERENCES;
  } catch {
    return DEFAULT_COMPANION_PREFERENCES;
  }
}

export function saveCompanionPreferences(preferences: CompanionPreferencesV1, storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): void {
  if (!storage) return;
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function updateCompanionPreferences(current: CompanionPreferencesV1, change: Partial<Pick<CompanionPreferencesV1, 'visualEnabled' | 'visualMode' | 'voiceEnabled' | 'proactiveSpeechEnabled'>>): CompanionPreferencesV1 {
  const next = parseCompanionPreferences({ ...current, ...change, schemaVersion: 1 });
  return next.visualEnabled ? next : { ...next, voiceEnabled: false, proactiveSpeechEnabled: false };
}
