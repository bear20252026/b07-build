import assert from 'node:assert/strict';
import test from 'node:test';
import { GITHUB_TOKEN_CREDENTIAL_ACCOUNT, loadGithubCollaborationPreferences, saveGithubCollaborationPreferences } from '../src/runtime/github-collaboration-preferences';

// SEC-007：PAT 本体只进系统凭据管理器；localStorage 旧明文在首次加载时迁移并清除。
const invokeCalls: { readonly cmd: string; readonly args: Record<string, unknown> }[] = [];
const secrets = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'credential_store') { secrets.set(String(args.account), String(args.secret)); return null; }
      if (cmd === 'credential_load') return secrets.get(String(args.account)) ?? null;
      if (cmd === 'credential_delete') { secrets.delete(String(args.account)); return null; }
      throw new Error(`unexpected command: ${cmd}`);
    },
  },
  localStorage: {
    store: new Map<string, string>(),
    getItem(key: string) { return this.store.get(key) ?? null; },
    setItem(key: string, value: string) { this.store.set(key, value); },
    removeItem(key: string) { this.store.delete(key); },
  },
};

function localStorageStub(): Storage {
  return ((globalThis as unknown as { window: { localStorage: Storage } }).window).localStorage;
}

test('保存令牌写入凭据管理器，localStorage 不留任何令牌内容', async () => {
  const storage = localStorageStub();
  invokeCalls.length = 0;
  await saveGithubCollaborationPreferences({ schemaVersion: 1, token: 'ghp_example' });
  assert.deepEqual(invokeCalls[0], { cmd: 'credential_store', args: { account: GITHUB_TOKEN_CREDENTIAL_ACCOUNT, secret: 'ghp_example' } });
  assert.equal(storage.store.size, 0);
  assert.equal(await loadGithubCollaborationPreferences().then((preferences) => preferences.token), 'ghp_example');
});

test('旧版 localStorage 明文令牌在首次加载时迁入凭据管理器并清除本地条目', async () => {
  const storage = localStorageStub();
  storage.setItem('awo.github-collaboration.v1', JSON.stringify({ schemaVersion: 1, token: 'ghp_legacy' }));
  const preferences = await loadGithubCollaborationPreferences();
  assert.equal(preferences.token, 'ghp_legacy');
  assert.equal(secrets.get(GITHUB_TOKEN_CREDENTIAL_ACCOUNT), 'ghp_legacy');
  assert.equal(storage.getItem('awo.github-collaboration.v1'), null);
});

test('保存空令牌会删除凭据管理器中的旧令牌', async () => {
  await saveGithubCollaborationPreferences({ schemaVersion: 1, token: '' });
  assert.equal(secrets.has(GITHUB_TOKEN_CREDENTIAL_ACCOUNT), false);
  assert.equal(await loadGithubCollaborationPreferences().then((preferences) => preferences.token), '');
});
