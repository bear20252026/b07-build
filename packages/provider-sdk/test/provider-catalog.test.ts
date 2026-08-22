import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILT_IN_PROVIDER_CATALOG } from '../src/index.js';

test('内置 MiMo 目录只提供按量 API 与中国区 Token Plan，并保留官方端点与凭据引用', () => {
  const mimoEntries = BUILT_IN_PROVIDER_CATALOG.list().filter((provider) => provider.id === 'mimo' || provider.id.startsWith('mimo-token-plan-'));

  assert.deepEqual(mimoEntries.map((provider) => provider.id), ['mimo', 'mimo-token-plan-cn']);
  assert.deepEqual(mimoEntries.map((provider) => ({
    id: provider.id,
    baseUrl: provider.baseUrl,
    credentialReference: provider.credentialReference,
    defaultModel: provider.defaultModel,
  })), [
    {
      id: 'mimo',
      baseUrl: 'https://api.xiaomimimo.com',
      credentialReference: 'env.mimo',
      defaultModel: 'mimo-v2.5-pro',
    },
    {
      id: 'mimo-token-plan-cn',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com',
      credentialReference: 'env.mimo-token-plan-cn',
      defaultModel: 'mimo-v2.5-pro',
    },
  ]);
});
