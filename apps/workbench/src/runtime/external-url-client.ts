import { invoke } from '@tauri-apps/api/core';

export async function openSearchSourceInSystemBrowser(url: string): Promise<void> {
  const normalized = url.trim();
  if (!/^https?:\/\//.test(normalized) || normalized.length > 2_048 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('external-url-invalid');
  await invoke('open_external_url', { url: normalized });
}
