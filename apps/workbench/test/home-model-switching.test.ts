import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitHomeModelSelection, homeModelCapabilityHint, homeModelChoices, isSelectableHomeModel } from '../src/runtime/home-model-switching';

const mimo = {
  schemaVersion: 1 as const,
  providerId: 'mimo-token-plan-cn',
  displayName: '我的 MiMo Token Plan（中国）',
  driverId: 'desktop-direct.openai-compatible',
  defaultModel: 'mimo-v2.5-pro',
  credentialReference: 'native-session',
  credentialAvailability: 'available' as const,
  profileStatus: 'active' as const,
  profileRevision: 1,
  canReadSecret: false,
  canAutoConnect: false,
};

test('首页模型选择器保留默认、MiMo 已知模型和第三方发现模型', () => {
  assert.deepEqual(homeModelChoices(mimo, {
    schemaVersion: 1,
    providerId: mimo.providerId,
    outcome: 'reachable',
    checkedAt: 1,
    models: ['mimo-v2.5-pro', 'mimo-v2.5-vision-preview'],
    canReadSecret: false,
    canAutoConnect: false,
  }), ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2.5-vision-preview']);
});

test('首页模型选择器接受标准模型标识但拒绝不安全的空白或空格值', () => {
  assert.equal(isSelectableHomeModel('gpt-4.1-mini'), true);
  assert.equal(isSelectableHomeModel('mimo-v2.5/vision'), true);
  assert.equal(isSelectableHomeModel(''), false);
  assert.equal(isSelectableHomeModel('model with space'), false);
});

test('首页显式模型输入始终绑定当前连接，不向 MiMo 或其他厂商静默回退', () => {
  assert.deepEqual(explicitHomeModelSelection('longcat', 'LongCat-Flash-Chat'), { providerId: 'longcat', model: 'LongCat-Flash-Chat' });
  assert.deepEqual(explicitHomeModelSelection('deepseek', 'deepseek-chat'), { providerId: 'deepseek', model: 'deepseek-chat' });
  assert.equal(explicitHomeModelSelection('longcat', 'model with space'), undefined);
});

test('MiMo 图片能力提示要求显式选择视觉模型，不声称本地拦截图片', () => {
  assert.match(homeModelCapabilityHint(mimo, 'mimo-v2.5-pro'), /显式切换到 mimo-v2.5/);
  assert.match(homeModelCapabilityHint(mimo, 'mimo-v2.5'), /图片将按当前/);
});
