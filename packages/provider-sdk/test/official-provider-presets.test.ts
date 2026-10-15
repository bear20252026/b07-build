// 一个文件=一种作用：内置离线目录查询语义的验收测试（覆盖迁移自 workbench 的回退规则）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFICIAL_PROVIDER_PRESETS, officialModelsForProvider } from '../src/config/index.js';

test('离线目录：精确 providerId 命中返回该厂商的官方模型清单', () => {
  assert.deepEqual(officialModelsForProvider('deepseek'), ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
  assert.deepEqual(officialModelsForProvider('kimi'), ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6']);
});

test('离线目录：连接 ID 未被收录时只按明确厂商品牌回退，且不回写任何连接字段', () => {
  assert.deepEqual(officialModelsForProvider('custom-1', 'My DeepSeek Proxy'), officialModelsForProvider('deepseek'));
  assert.deepEqual(officialModelsForProvider('custom-2', 'moonshot relay'), officialModelsForProvider('kimi'));
  assert.deepEqual(officialModelsForProvider('custom-3', '完全无关的连接'), []);
});

test('离线目录：预设条目的 baseUrl 只覆盖声明过的协议', () => {
  const kimi = OFFICIAL_PROVIDER_PRESETS.find((preset) => preset.id === 'kimi');
  assert.equal(kimi?.defaultBaseUrls['openai-compatible'], 'https://api.moonshot.cn/v1');
  assert.equal(kimi?.defaultBaseUrls['anthropic-compatible'], undefined);
});
