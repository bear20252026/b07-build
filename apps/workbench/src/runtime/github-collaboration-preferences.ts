import { deleteCredential, loadCredential, storeCredential } from './credentials';

export const GITHUB_TOKEN_CREDENTIAL_ACCOUNT = 'github/token';

/** SEC-007：PAT 本体只存系统凭据管理器；localStorage 不再保存任何令牌内容。 */
export interface GithubCollaborationPreferences { readonly schemaVersion: 1; readonly token: string; }

const LEGACY_STORAGE_KEY = 'awo.github-collaboration.v1';

/** 旧版 localStorage 明文令牌一次性搬进凭据管理器，随后删除本地条目。 */
async function migrateLegacyToken(): Promise<void> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? '{}');
    const legacy = value && typeof value === 'object' && typeof (value as { token?: unknown }).token === 'string'
      ? (value as { token: string }).token.slice(0, 4096)
      : '';
    if (!legacy) return;
    await storeCredential(GITHUB_TOKEN_CREDENTIAL_ACCOUNT, legacy);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch { /* 迁移失败不影响主流程；用户重新输入一次即可。 */ }
}

export async function loadGithubCollaborationPreferences(): Promise<GithubCollaborationPreferences> {
  await migrateLegacyToken();
  const token = await loadCredential(GITHUB_TOKEN_CREDENTIAL_ACCOUNT);
  return { schemaVersion: 1, token: (token ?? '').slice(0, 4096) };
}

export async function saveGithubCollaborationPreferences(preferences: GithubCollaborationPreferences): Promise<void> {
  const token = preferences.token.slice(0, 4096);
  if (token) {
    await storeCredential(GITHUB_TOKEN_CREDENTIAL_ACCOUNT, token);
  } else {
    await deleteCredential(GITHUB_TOKEN_CREDENTIAL_ACCOUNT);
  }
}
