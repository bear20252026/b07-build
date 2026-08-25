import { invoke } from '@tauri-apps/api/core';

export type NativeRuntimePlatform = 'android' | 'desktop' | 'web';

export interface NativeRuntimePlatformStatus {
  readonly platform: NativeRuntimePlatform;
  readonly supportsDirectProvider: boolean;
  readonly supportsExternalHttpLinks: boolean;
  readonly supportsTerminal: boolean;
  readonly supportsDesktopCompanion: boolean;
  readonly supportsDesktopSaveAs: boolean;
  readonly supportsLocalPythonResearch: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

const WEB_STATUS: NativeRuntimePlatformStatus = Object.freeze({
  platform: 'web',
  supportsDirectProvider: false,
  supportsExternalHttpLinks: true,
  supportsTerminal: false,
  supportsDesktopCompanion: false,
  supportsDesktopSaveAs: false,
  supportsLocalPythonResearch: false,
});

function platformStatusFrom(value: unknown): NativeRuntimePlatformStatus {
  if (!value || typeof value !== 'object') throw new Error('native-platform-status-invalid');
  const status = value as Record<string, unknown>;
  if (!['android', 'desktop'].includes(String(status.platform))) throw new Error('native-platform-status-invalid');
  const fields = ['supportsDirectProvider', 'supportsExternalHttpLinks', 'supportsTerminal', 'supportsDesktopCompanion', 'supportsDesktopSaveAs', 'supportsLocalPythonResearch'] as const;
  if (fields.some((field) => typeof status[field] !== 'boolean')) throw new Error('native-platform-status-invalid');
  return {
    platform: status.platform as Exclude<NativeRuntimePlatform, 'web'>,
    supportsDirectProvider: status.supportsDirectProvider as boolean,
    supportsExternalHttpLinks: status.supportsExternalHttpLinks as boolean,
    supportsTerminal: status.supportsTerminal as boolean,
    supportsDesktopCompanion: status.supportsDesktopCompanion as boolean,
    supportsDesktopSaveAs: status.supportsDesktopSaveAs as boolean,
    supportsLocalPythonResearch: status.supportsLocalPythonResearch as boolean,
  };
}

export const nativePlatformClient = Object.freeze({
  async read(): Promise<NativeRuntimePlatformStatus> {
    if (!isTauriRuntime()) return WEB_STATUS;
    return platformStatusFrom(await invoke('native_runtime_platform'));
  },
});
