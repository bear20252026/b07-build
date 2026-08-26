import assert from 'node:assert/strict';
import test from 'node:test';
import { DIRECT_PROVIDER_ACCOUNTS_STORAGE, loadDirectProviderAccounts, saveDirectProviderAccount } from '../src/runtime/direct-provider-accounts.js';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  } as Storage;
}

test('直接 Provider 账户持久化会保存完整配置并替换同 providerId 的旧版本', () => {
    const storage = memoryStorage();
    saveDirectProviderAccount({ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo', protocol: 'openai-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', apiKey: 'tp-example' }, storage);
    saveDirectProviderAccount({ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo 更新', protocol: 'anthropic-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', model: 'mimo-v2.5-pro', apiKey: 'tp-updated' }, storage);
  assert.deepEqual(loadDirectProviderAccounts(storage), [{ schemaVersion: 1, providerId: 'mimo-token-plan-cn', displayName: '我的 MiMo 更新', protocol: 'anthropic-compatible', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', model: 'mimo-v2.5-pro', apiKey: 'tp-updated' }]);
});

test('直接 Provider 账户持久化不会绑定设备地址或指纹', () => {
  const storage = memoryStorage();
  saveDirectProviderAccount({ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'sk-example', deviceAddress: '192.168.1.20', deviceFingerprint: 'machine-secret' } as never, storage);
  assert.deepEqual(loadDirectProviderAccounts(storage), [{ schemaVersion: 1, providerId: 'custom-openai', displayName: '自定义 OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'example-model', apiKey: 'sk-example' }]);
});

test('直接 Provider 账户持久化会安全忽略异常本地记录', () => {
    const storage = memoryStorage({ [DIRECT_PROVIDER_ACCOUNTS_STORAGE]: JSON.stringify([{ schemaVersion: 1, providerId: 'bad id', displayName: 'X', protocol: 'unknown', baseUrl: '', model: '', apiKey: '' }]) });
  assert.deepEqual(loadDirectProviderAccounts(storage), []);
});
