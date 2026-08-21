import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelDecisionReceipt } from '../src/components/workspace/model-decision-receipt.js';

const connection = { schemaVersion: 1, providerId: 'deepseek', displayName: 'DeepSeek', driverId: 'openai-compatible', defaultModel: 'deepseek-chat', credentialReference: 'env.deepseek-api-key', credentialAvailability: 'available' as const, profileStatus: 'active' as const, canReadSecret: false as const, canAutoConnect: false as const };

test('模型决策收据只记录显式选择与脱敏可用连接，不生成自动路由或密钥读取能力', () => {
  const receipt = createModelDecisionReceipt({ profileId: 'build', authorityMode: 'review', connections: [connection] });
  assert.equal(receipt.connectionStatus, 'available');
  assert.equal(receipt.connectedProviderCount, 1);
  assert.equal(receipt.canAutoRoute, false);
  assert.equal(receipt.canReadSecret, false);
});

test('没有激活连接时保留未配置状态且不伪造模型可用性', () => {
  const receipt = createModelDecisionReceipt({ profileId: 'plan', authorityMode: 'plan', connections: [] });
  assert.equal(receipt.connectionStatus, 'unconfigured');
  assert.match(receipt.summary, /不会自动连接/);
});
