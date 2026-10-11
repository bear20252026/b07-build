import assert from 'node:assert/strict';
import test from 'node:test';
import { DIRECT_PROVIDER_ACCOUNTS_STORAGE, loadDirectProviderAccounts, restoreDirectProviderAccounts, saveDirectProviderAccount } from '../src/runtime/direct-provider-accounts.js';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  } as Storage;
}

/** 凭据管理器内存桩：SEC-006 的契约就是"密钥只进 secret store，localStorage 不留明文"。 */
function memorySecrets(initial: Record<string, string> = {}) {
  const secrets = new Map(Object.entries(initial));
  const stored: { account: string; secret: string }[] = [];
  return {
    stored,
    secrets,
    store: async (account: string, secret: string) => { stored.push({ account, secret }); secrets.set(account, secret); },
    load: async (account: string) => secrets.get(account),
  };
}

test('保存账户后密钥进凭据管理器，localStorage 只留 keyring 元数据', async () => {
  const storage = memoryStorage();
  const vault = memorySecrets();
  await saveDirectProviderAccount({ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo', protocol: 'openai-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', apiKey: 'tp-example' }, storage, vault);
  assert.deepEqual(vault.stored, [{ account: 'provider/mimo-token-plan-cn', secret: 'tp-example' }]);
  const raw: unknown = JSON.parse(storage.getItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE) ?? '[]');
  assert.deepEqual(raw, [{ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo', protocol: 'openai-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', credential: 'keyring' }]);
  // 同步读取只给元数据，密钥位为空。
  assert.deepEqual(loadDirectProviderAccounts(storage).map((account) => account.apiKey), ['']);
});

test('重复保存替换同 providerId 的旧版本，密钥更新到凭据管理器', async () => {
  const storage = memoryStorage();
  const vault = memorySecrets();
  await saveDirectProviderAccount({ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo', protocol: 'openai-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', apiKey: 'tp-example' }, storage, vault);
  await saveDirectProviderAccount({ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo 更新', protocol: 'anthropic-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', model: 'mimo-v2.5-pro', apiKey: 'tp-updated' }, storage, vault);
  assert.deepEqual(vault.secrets.get('provider/mimo-token-plan-cn'), 'tp-updated');
  const raw: unknown = JSON.parse(storage.getItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE) ?? '[]');
  assert.equal((raw as { length: number }).length, 1);
  const restored = await restoreDirectProviderAccounts(storage, vault);
  assert.deepEqual(restored, [{ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo 更新', protocol: 'anthropic-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', model: 'mimo-v2.5-pro', apiKey: 'tp-updated' }]);
});

test('旧版 localStorage 明文账户在恢复时迁入凭据管理器并改写为 keyring 元数据', async () => {
  const storage = memoryStorage({ [DIRECT_PROVIDER_ACCOUNTS_STORAGE]: JSON.stringify([{ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'sk-example' }]) });
  const vault = memorySecrets();
  const restored = await restoreDirectProviderAccounts(storage, vault);
  assert.deepEqual(vault.secrets.get('provider/custom-openai'), 'sk-example');
  assert.deepEqual(restored, [{ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'sk-example' }]);
  const raw: unknown = JSON.parse(storage.getItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE) ?? '[]');
  assert.deepEqual(raw, [{ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', credential: 'keyring' }]);
});

test('凭据管理器里查不到密钥时按空密钥账户返回，调用方引导重新连接', async () => {
  const storage = memoryStorage({ [DIRECT_PROVIDER_ACCOUNTS_STORAGE]: JSON.stringify([{ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', credential: 'keyring' }]) });
  const vault = memorySecrets();
  const restored = await restoreDirectProviderAccounts(storage, vault);
  assert.deepEqual(restored, [{ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: '' }]);
});

test('保存账户不会绑定设备地址或指纹等额外字段', async () => {
  const storage = memoryStorage();
  const vault = memorySecrets();
  await saveDirectProviderAccount({ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'sk-example', deviceAddress: '192.168.1.20', deviceFingerprint: 'machine-secret' } as never, storage, vault);
  const raw: unknown = JSON.parse(storage.getItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE) ?? '[]');
  assert.deepEqual(raw, [{ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', credential: 'keyring' }]);
});

test('异常本地记录被安全忽略', async () => {
  const storage = memoryStorage({ [DIRECT_PROVIDER_ACCOUNTS_STORAGE]: JSON.stringify([{ schemaVersion: 1, providerId: 'bad id', displayName: 'X', protocol: 'unknown', baseUrl: '', model: '', apiKey: '' }]) });
  assert.deepEqual(loadDirectProviderAccounts(storage), []);
});
