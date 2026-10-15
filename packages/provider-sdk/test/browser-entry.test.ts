// 一个文件=一种作用：provider-sdk 浏览器入口边界的验收测试。
// 展示层（apps/workbench）只能从 `@awo/provider-sdk/browser` 取东西，
// 因此这个入口一旦漏出远端目录层，分层约束就会从「策略挡住」退化成「靠自觉」。

import assert from 'node:assert/strict';
import test from 'node:test';
import * as browserEntry from '../browser/index.js';

test('浏览器入口：只导出零 IO、零传输的配置层与执行适配层', () => {
  assert.equal(typeof browserEntry.ProviderRegistry, 'function');
  assert.equal(typeof browserEntry.compileModelOptionMap, 'function');
  assert.equal(typeof browserEntry.officialModelsForProvider, 'function');
  assert.equal(Array.isArray(browserEntry.OFFICIAL_PROVIDER_PRESETS), true);
  assert.equal(typeof browserEntry.classifyProviderFailure, 'function');
  assert.equal(typeof browserEntry.retryDelayMs, 'function');
  assert.equal(typeof browserEntry.createSecretSafeFetch, 'function');
  assert.equal(typeof browserEntry.safeEndpointLabel, 'function');
  assert.equal(typeof browserEntry.extractProviderErrorCode, 'function');
});

test('浏览器入口：绝不导出持有注入式传输的远端目录层', () => {
  assert.equal('RemoteProviderCatalog' in browserEntry, false);
  assert.equal('CatalogSyncError' in browserEntry, false);
  assert.equal('materializeRemoteCatalog' in browserEntry, false);
});
