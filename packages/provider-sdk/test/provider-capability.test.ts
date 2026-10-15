// 一个文件=一种作用：provider 能力面契约与能力探测的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import * as browserEntry from '../browser/index.js';
import {
  isProviderCapabilityAvailable,
  probeProviderCapabilities,
  ProviderRegistry,
  PROVIDER_CAPABILITY_IDS,
  resolveProviderCapability,
  type ProviderCapabilityFacets,
  type ProviderDefinition,
} from '../src/config/index.js';

function definition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    providerId: 'example',
    providerName: 'Example',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.example.test/v1',
    defaultModel: 'example-model',
    models: [{ modelId: 'example-model', optionSpecs: {} }],
    ...overrides,
  };
}

/** 一组「完整」的能力面替身，用于验证「面在即可用」。 */
function fullFacets(): ProviderCapabilityFacets {
  return {
    models: { listModels: async () => [] },
    auth: { getStatus: async () => ({ state: 'unconfigured' }) },
    sessions: {
      listSessions: async () => [],
      fetchHistory: async () => ({ sessionId: 's', messages: [] }),
    },
    mcp: {
      listServers: async () => [],
      upsertServer: async () => ({ name: 'n', scope: 'user' }),
      removeServer: async () => false,
    },
    skills: {
      listSkills: async () => [],
      addSkill: async () => ({ name: 'n' }),
      removeSkill: async () => false,
    },
    runtime: { run: async () => undefined, abort: () => true },
    fork: { forkSession: async () => ({ providerSessionId: 'p2' }) },
    synchronizer: { synchronize: async () => 0, synchronizeFile: async () => null },
  };
}

test('能力探测：能力集合为空时全部 fail-closed，原因码为 provider-capability-absent', () => {
  const manifest = probeProviderCapabilities();
  assert.deepEqual(
    manifest.capabilities.map((item) => item.capability),
    [...PROVIDER_CAPABILITY_IDS],
  );
  for (const item of manifest.capabilities) {
    assert.equal(item.available, false);
    assert.equal(item.reason, 'provider-capability-absent');
  }
});

test('能力探测：清单顺序稳定且冻结，与输入对象的键顺序无关', () => {
  const manifest = probeProviderCapabilities(fullFacets());
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.capabilities));
  assert.deepEqual(
    manifest.capabilities.map((item) => item.capability),
    [...PROVIDER_CAPABILITY_IDS],
  );
});

test('能力探测：只登记部分能力面时，其余面一律判为缺席', () => {
  const manifest = probeProviderCapabilities({
    models: { listModels: async () => [] },
    auth: { getStatus: async () => ({ state: 'unauthenticated' }) },
  });
  assert.equal(isProviderCapabilityAvailable(manifest, 'model-catalog'), true);
  assert.equal(isProviderCapabilityAvailable(manifest, 'auth'), true);
  assert.equal(isProviderCapabilityAvailable(manifest, 'runtime'), false);
  assert.equal(isProviderCapabilityAvailable(manifest, 'fork'), false);
  assert.equal(resolveProviderCapability(manifest, 'fork').reason, 'provider-capability-absent');
});

test('可选能力即缺席：面内可选方法不在时，细粒度能力不可用；补上即可用', () => {
  const withoutOptional = probeProviderCapabilities({
    runtime: { run: async () => undefined, abort: () => true },
    sessions: { listSessions: async () => [], fetchHistory: async () => ({ sessionId: 's', messages: [] }) },
  });
  assert.equal(isProviderCapabilityAvailable(withoutOptional, 'runtime'), true);
  assert.equal(isProviderCapabilityAvailable(withoutOptional, 'runtime-background-work'), false);
  assert.equal(isProviderCapabilityAvailable(withoutOptional, 'session-edit-anchor'), false);

  const withOptional = probeProviderCapabilities({
    runtime: {
      run: async () => undefined,
      abort: () => true,
      listBackgroundWork: () => [],
    },
    sessions: {
      listSessions: async () => [],
      fetchHistory: async () => ({ sessionId: 's', messages: [] }),
      resolveEditAnchor: async () => ({ found: false, resumeThroughId: null }),
    },
  });
  assert.equal(isProviderCapabilityAvailable(withOptional, 'runtime-background-work'), true);
  assert.equal(isProviderCapabilityAvailable(withOptional, 'session-edit-anchor'), true);
});

test('可选字段缺席语义：显式 undefined 与不写字段等价，null 也按缺席处理', () => {
  const omitted = probeProviderCapabilities({ fork: undefined });
  const empty = probeProviderCapabilities({});
  assert.deepEqual(omitted, empty);

  const nulled = probeProviderCapabilities({ fork: null } as unknown as ProviderCapabilityFacets);
  assert.equal(isProviderCapabilityAvailable(nulled, 'fork'), false);
  assert.equal(resolveProviderCapability(nulled, 'fork').reason, 'provider-capability-absent');
});

test('未知能力 fail-closed：未登记的 id 一律不可用，原因码为 provider-capability-unknown', () => {
  const manifest = probeProviderCapabilities(fullFacets());
  assert.deepEqual(resolveProviderCapability(manifest, 'telepathy'), {
    capability: 'telepathy',
    available: false,
    reason: 'provider-capability-unknown',
  });
  assert.equal(isProviderCapabilityAvailable(manifest, 'telepathy'), false);
});

test('注册表集成：能力集合与连接描述分开登记，查询与探测互不干扰既有 API', () => {
  const registry = new ProviderRegistry([definition()]);
  // 尚未登记能力集合：provider 已登记，但清单为「全部不可用」。
  const before = registry.describeCapabilities('example');
  assert.ok(before);
  assert.equal(before.capabilities.every((item) => !item.available), true);
  assert.equal(registry.getCapabilities('example'), undefined);

  registry.registerCapabilities('example', { fork: { forkSession: async () => ({ providerSessionId: 'p2' }) } });
  const after = registry.describeCapabilities('example');
  assert.ok(after);
  assert.equal(isProviderCapabilityAvailable(after, 'fork'), true);
  assert.equal(isProviderCapabilityAvailable(after, 'mcp'), false);
  assert.equal(registry.getCapabilities('example')?.fork !== undefined, true);

  // 未登记的 provider：查询返回 undefined，登记被拒绝。
  assert.equal(registry.describeCapabilities('ghost'), undefined);
  assert.equal(registry.getCapabilities('ghost'), undefined);
  assert.throws(() => registry.registerCapabilities('ghost', {}), /未登记的 Provider/u);

  // 既有选择校验不受影响。
  assert.deepEqual(registry.validateSelection({ providerId: 'example', modelId: 'example-model' }), {
    ok: true,
    requestPatch: {},
  });
});

test('注册表集成：目录整体替换后，已消失 provider 的悬挂能力被清除', () => {
  const registry = new ProviderRegistry([definition()]);
  registry.registerCapabilities('example', { auth: { getStatus: async () => ({ state: 'authenticated' }) } });
  registry.replace([], '目录清空');
  assert.equal(registry.getCapabilities('example'), undefined);
  assert.equal(registry.describeCapabilities('example'), undefined);
});

test('浏览器出口：能力面契约与探测函数可从 @awo/provider-sdk/browser 取得', () => {
  assert.equal(typeof browserEntry.probeProviderCapabilities, 'function');
  assert.equal(typeof browserEntry.resolveProviderCapability, 'function');
  assert.equal(typeof browserEntry.isProviderCapabilityAvailable, 'function');
  assert.equal(Array.isArray(browserEntry.PROVIDER_CAPABILITY_IDS), true);
});
