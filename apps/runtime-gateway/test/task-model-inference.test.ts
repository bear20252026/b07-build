import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderConnectionService, ProviderInferenceService, SessionCustomProviderService } from '@awo/provider-sdk';
import { createTaskModelInferencePort } from '../src/task-model-inference.js';

const activeConnection = {
  schemaVersion: 1 as const, providerId: 'mimo-token-plan-cn', displayName: 'MiMo Token Plan（中国）', driverId: 'remote-openai-compatible-mimo-token-plan-cn', defaultModel: 'mimo-v2.5-pro', credentialReference: 'env.MIMO_TOKEN_PLAN_CN_API_KEY', credentialAvailability: 'available' as const, profileStatus: 'active' as const, profileRevision: 1, canReadSecret: false as const, canAutoConnect: false as const,
};

const noCustomProviders = { list: () => [], infer: async () => { throw new Error('不应调用'); } } as unknown as SessionCustomProviderService;

function inferenceResult(providerId: string, model: string) {
  return { schemaVersion: 1 as const, providerId, profileId: `provider.${providerId}`, profileRevision: 1, model, dataBoundary: 'remote-allowed' as const, output: '真实模型结果', outputDigest: 'a'.repeat(64), outputCharacters: 6, latencyMs: 12, canReadSecret: false as const, canAutoExecuteTools: false as const, canAutoConnect: false as const };
}

test('任务模型端口只调用本次任务明确选择的内置 Provider，而不接收地址或密钥', async () => {
  const calls: unknown[] = [];
  const second = { ...activeConnection, providerId: 'deepseek', defaultModel: 'deepseek-v4-pro' };
  const connections = { list: () => [activeConnection, second] } as unknown as ProviderConnectionService;
  const inference = { infer: async (request: unknown) => { calls.push(request); return inferenceResult('deepseek', 'deepseek-v4-pro'); } } as unknown as ProviderInferenceService;
  const result = await createTaskModelInferencePort(connections, inference, noCustomProviders).infer({ goal: '生成计划', profileId: 'build', modelSelection: { providerId: 'deepseek' } });
  assert.deepEqual(calls, [{ providerId: 'deepseek', model: 'deepseek-v4-pro', prompt: '生成计划' }]);
  assert.equal(result?.output, '真实模型结果');
  assert.equal(result?.providerId, 'deepseek');
});

test('任务模型端口未选择模型时不发起远程调用，即使存在活动连接', async () => {
  const connections = { list: () => [activeConnection] } as unknown as ProviderConnectionService;
  const inference = { infer: async () => { throw new Error('不应调用'); } } as unknown as ProviderInferenceService;
  const result = await createTaskModelInferencePort(connections, inference, noCustomProviders).infer({ goal: '生成计划', profileId: 'plan' });
  assert.equal(result, undefined);
});

test('任务模型端口可以调用本次任务明确选择的自定义会话模型', async () => {
  const calls: unknown[] = [];
  const custom = { ...activeConnection, providerId: 'custom-12345678', displayName: '我的兼容模型', driverId: 'remote.custom-12345678', defaultModel: 'owner-model-v1', credentialReference: 'session.custom-12345678' };
  const customProviders = { list: () => [custom], infer: async (request: unknown) => { calls.push(request); return inferenceResult('custom-12345678', 'owner-model-v2'); } } as unknown as SessionCustomProviderService;
  const connections = { list: () => [] } as unknown as ProviderConnectionService;
  const inference = { infer: async () => { throw new Error('不应调用内置推理'); } } as unknown as ProviderInferenceService;
  const result = await createTaskModelInferencePort(connections, inference, customProviders).infer({ goal: '生成计划', profileId: 'build', modelSelection: { providerId: 'custom-12345678', model: 'owner-model-v2' } });
  assert.deepEqual(calls, [{ providerId: 'custom-12345678', model: 'owner-model-v2', prompt: '生成计划' }]);
  assert.equal(result?.providerId, 'custom-12345678');
});

test('任务模型端口拒绝已失效或未启用的显式模型选择', async () => {
  const inactive = { ...activeConnection, profileStatus: 'disabled' as const };
  const connections = { list: () => [inactive] } as unknown as ProviderConnectionService;
  const inference = { infer: async () => { throw new Error('不应调用'); } } as unknown as ProviderInferenceService;
  await assert.rejects(() => createTaskModelInferencePort(connections, inference, noCustomProviders).infer({ goal: '生成计划', profileId: 'build', modelSelection: { providerId: 'mimo-token-plan-cn' } }), /尚未连接或未启用/);
});
