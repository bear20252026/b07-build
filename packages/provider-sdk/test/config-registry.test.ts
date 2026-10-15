// 一个文件=一种作用：provider 注册表的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderRegistry,
  builtinProviderDefinitions,
  OFFICIAL_PROVIDER_PRESETS,
  type ProviderDefinition,
} from '../src/config/index.js';

function definition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    providerId: 'example',
    providerName: 'Example',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.example.test/v1',
    defaultModel: 'example-model',
    models: [
      {
        modelId: 'example-model',
        optionSpecs: {
          reasoningLevel: {
            map: '{"reasoning_effort":"$reasoningLevel"}',
            values: ['low', 'high'],
            defaultValue: 'low',
          },
        },
      },
    ],
    ...overrides,
  };
}

test('内置目录物化：每个离线 preset 都变成一条注册表定义，协议与默认地址自洽', () => {
  const definitions = builtinProviderDefinitions();
  assert.equal(definitions.length, OFFICIAL_PROVIDER_PRESETS.length);
  for (const item of definitions) {
    assert.ok(item.providerId.length > 0);
    assert.ok(['openai-compatible', 'anthropic-compatible'].includes(item.protocol));
    assert.ok(item.models.some((model) => model.modelId === item.defaultModel));
  }
  const anthropic = definitions.find((item) => item.providerId === 'anthropic');
  assert.equal(anthropic?.protocol, 'anthropic-compatible');
  assert.equal(anthropic?.defaultBaseUrl, 'https://api.anthropic.com');
});

test('注册表：按 providerId / modelId 命中，未知 id 返回 undefined', () => {
  const registry = new ProviderRegistry([definition()]);
  assert.equal(registry.getProvider('example')?.providerName, 'Example');
  assert.equal(registry.getModel('example', 'example-model')?.modelId, 'example-model');
  assert.equal(registry.getProvider('missing'), undefined);
  assert.equal(registry.getModel('example', 'missing'), undefined);
});

test('选择校验：通过时顺带产出请求体补丁，未提供选项时回填默认值', () => {
  const registry = new ProviderRegistry([definition()]);
  const result = registry.validateSelection({ providerId: 'example', modelId: 'example-model' });
  assert.deepEqual(result, { ok: true, requestPatch: { reasoning_effort: 'low' } });
});

test('选择校验：provider / model / 选项值三类失败各自给出稳定 code', () => {
  const registry = new ProviderRegistry([definition()]);
  const missingProvider = registry.validateSelection({ providerId: 'ghost', modelId: 'x' });
  assert.deepEqual(missingProvider, { ok: false, code: 'provider-not-found', providerId: 'ghost' });

  const missingModel = registry.validateSelection({ providerId: 'example', modelId: 'ghost' });
  assert.deepEqual(missingModel, { ok: false, code: 'model-not-found', providerId: 'example', modelId: 'ghost' });

  const badOption = registry.validateSelection({
    providerId: 'example',
    modelId: 'example-model',
    options: { reasoningLevel: 'extreme' },
  });
  if (badOption.ok || badOption.code !== 'option-not-supported') assert.fail('期望 option-not-supported');
  assert.equal(badOption.option, 'reasoningLevel');
  assert.equal(badOption.value, 'extreme');
  assert.deepEqual(badOption.supportedValues, ['low', 'high']);
});

test('注册表：整体替换自增 revision 并广播，重复 id 直接拒绝', () => {
  const registry = new ProviderRegistry([definition()]);
  const seen: number[] = [];
  const dispose = registry.onDidChange((event) => seen.push(event.revision));
  registry.replace([definition({ providerName: 'Example v2' })], '远端目录同步');
  assert.equal(registry.revision, 1);
  assert.deepEqual(seen, [1]);
  assert.equal(registry.getProvider('example')?.providerName, 'Example v2');
  dispose();
  registry.replace([], '再次同步');
  assert.deepEqual(seen, [1]);

  assert.throws(() => new ProviderRegistry([definition(), definition()]), /重复 Provider/u);
});
