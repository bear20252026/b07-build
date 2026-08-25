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

test('首页模型选择器保留默认、官方 MiMo 目录和第三方发现模型', () => {
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

test('首页模型选择器提供 DeepSeek V4 Flash 与 Kimi 官方目录，但不阻止用户手填其它有效模型', () => {
  const deepseek = { ...mimo, providerId: 'deepseek', displayName: '我的 DeepSeek', defaultModel: 'deepseek-v4-pro' };
  assert.deepEqual(homeModelChoices(deepseek, undefined), ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
  const kimi = { ...mimo, providerId: 'kimi', displayName: '我的 Kimi', defaultModel: 'kimi-k3' };
  assert.deepEqual(homeModelChoices(kimi, undefined), ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6']);
  assert.deepEqual(explicitHomeModelSelection('kimi', 'kimi-user-enabled-preview'), { providerId: 'kimi', model: 'kimi-user-enabled-preview' });
});

test('历史或自定义命名的 DeepSeek 连接仍投影 V4 Flash，不覆盖用户当前模型', () => {
  const legacyDeepSeek = { ...mimo, providerId: 'custom-my-deepseek-7f9e', displayName: '我的 DeepSeek API', defaultModel: 'deepseek-chat' };
  assert.deepEqual(homeModelChoices(legacyDeepSeek, undefined), ['deepseek-chat', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
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
