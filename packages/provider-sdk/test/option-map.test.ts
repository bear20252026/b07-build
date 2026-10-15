// 一个文件=一种作用：模型选项映射的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelOptionMapError,
  compileModelOptionMap,
  mergeOptionPatches,
  resolveModelOptionValues,
  type ModelOptionSpecs,
} from '../src/config/index.js';

const specs: ModelOptionSpecs = {
  reasoningLevel: {
    map: '{"reasoning_effort":"$reasoningLevel"}',
    values: ['disabled', 'low', 'high'],
    defaultValue: 'low',
  },
  maxOutputTokens: { map: '{"max_tokens":"$maxOutputTokens"}' },
};

test('选项映射：模板引用被替换为实际值，未提供的选项整支跳过', () => {
  assert.deepEqual(compileModelOptionMap(specs, { maxOutputTokens: '2048' }), {
    reasoning_effort: 'low',
    max_tokens: '2048',
  });
});

test('选项映射：声明了默认值的选项在缺省时回填，未声明默认值的选项不出现', () => {
  const values = resolveModelOptionValues(specs, undefined);
  assert.deepEqual(values, { reasoningLevel: 'low' });
});

test('选项映射：取值不在闭集内时抛出稳定错误码', () => {
  assert.throws(
    () => compileModelOptionMap(specs, { reasoningLevel: 'extreme' }),
    (error: unknown) => {
      assert.ok(error instanceof ModelOptionMapError);
      assert.equal(error.code, 'value-not-supported');
      assert.equal(error.option, 'reasoningLevel');
      return true;
    },
  );
});

test('选项映射：模板引用了本次调用未提供的选项值时抛错，而不是静默丢掉该键', () => {
  const broken: ModelOptionSpecs = {
    temperature: { map: '{"temperature":"$topP"}' },
    topP: { map: '{"top_p":"$topP"}' },
  };
  assert.throws(
    () => compileModelOptionMap(broken, { temperature: '0.5' }),
    (error: unknown) => error instanceof ModelOptionMapError && error.code === 'unresolved-reference',
  );
});

test('选项映射：模板必须是合法 JSON 对象', () => {
  assert.throws(
    () => compileModelOptionMap({ a: { map: 'not json' } }, { a: 'x' }),
    (error: unknown) => error instanceof ModelOptionMapError && error.code === 'map-not-json',
  );
  assert.throws(
    () => compileModelOptionMap({ a: { map: '[]' } }, { a: 'x' }),
    (error: unknown) => error instanceof ModelOptionMapError && error.code === 'map-not-object',
  );
});

test('选项映射：嵌套模板逐层解析，补丁深合并且数组整体替换', () => {
  const nested: ModelOptionSpecs = {
    level: { map: '{"thinking":{"level":"$level"}}' },
    // 带默认值的字面量模板：与调用方传值无关，始终参与补丁。
    sampling: { map: '{"sampling":{"top_k":[1,2]}}', defaultValue: 'on' },
  };
  assert.deepEqual(compileModelOptionMap(nested, { level: 'high' }), {
    thinking: { level: 'high' },
    sampling: { top_k: [1, 2] },
  });

  assert.deepEqual(mergeOptionPatches({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  assert.deepEqual(mergeOptionPatches({ a: [1, 2] }, { a: [3] }), { a: [3] });
});
