import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderConnectionService, ProviderInferenceService } from '@awo/provider-sdk';
import { createTaskModelInferencePort } from '../src/task-model-inference.js';

const activeConnection = {
  schemaVersion: 1 as const,
  providerId: 'mimo-token-plan-cn',
  displayName: 'MiMo Token Plan（中国）',
  driverId: 'remote-openai-compatible-mimo-token-plan-cn',
  defaultModel: 'mimo-v2.5-pro',
  credentialReference: 'env.MIMO_TOKEN_PLAN_CN_API_KEY',
  credentialAvailability: 'available' as const,
  profileStatus: 'active' as const,
  profileRevision: 1,
  canReadSecret: false as const,
  canAutoConnect: false as const,
};

test('任务模型端口将目标交给唯一活动内置 Provider，而不接收地址或密钥', async () => {
  const calls: unknown[] = [];
  const connections = { list: () => [activeConnection] } as unknown as ProviderConnectionService;
  const inference = {
    infer: async (request: unknown) => {
      calls.push(request);
      return { schemaVersion: 1 as const, providerId: 'mimo-token-plan-cn', profileId: 'provider.mimo-token-plan-cn', profileRevision: 1, model: 'mimo-v2.5-pro', dataBoundary: 'remote-allowed' as const, output: '真实模型结果', outputDigest: 'a'.repeat(64), outputCharacters: 6, latencyMs: 12, canReadSecret: false as const, canAutoExecuteTools: false as const, canAutoConnect: false as const };
    },
  } as unknown as ProviderInferenceService;
  const result = await createTaskModelInferencePort(connections, inference).infer({ goal: '生成计划', profileId: 'build' });
  assert.deepEqual(calls, [{ providerId: 'mimo-token-plan-cn', model: 'mimo-v2.5-pro', prompt: '生成计划' }]);
  assert.equal(result?.output, '真实模型结果');
  assert.equal(result?.providerId, 'mimo-token-plan-cn');
});

test('任务模型端口在没有活动连接时不发起远程调用', async () => {
  const connections = { list: () => [] } as unknown as ProviderConnectionService;
  const inference = { infer: async () => { throw new Error('不应调用'); } } as unknown as ProviderInferenceService;
  const result = await createTaskModelInferencePort(connections, inference).infer({ goal: '生成计划', profileId: 'plan' });
  assert.equal(result, undefined);
});

test('任务模型端口拒绝在多个活动内置连接之间静默选择', async () => {
  const second = { ...activeConnection, providerId: 'deepseek', defaultModel: 'deepseek-v4-pro' };
  const connections = { list: () => [activeConnection, second] } as unknown as ProviderConnectionService;
  const inference = { infer: async () => { throw new Error('不应调用'); } } as unknown as ProviderInferenceService;
  await assert.rejects(() => createTaskModelInferencePort(connections, inference).infer({ goal: '生成计划', profileId: 'build' }), /多个模型/);
});
