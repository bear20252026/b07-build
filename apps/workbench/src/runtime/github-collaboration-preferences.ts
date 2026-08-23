const STORAGE_KEY = 'awo.github-collaboration.v1';

export interface GithubCollaborationPreferences { readonly schemaVersion: 1; readonly token: string; }

export function loadGithubCollaborationPreferences(): GithubCollaborationPreferences {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    const token = value && typeof value === 'object' && typeof (value as { token?: unknown }).token === 'string' ? (value as { token: string }).token : '';
    return { schemaVersion: 1, token: token.slice(0, 4096) };
  } catch { return { schemaVersion: 1, token: '' }; }
}

export function saveGithubCollaborationPreferences(preferences: GithubCollaborationPreferences): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, token: preferences.token.slice(0, 4096) }));
}
