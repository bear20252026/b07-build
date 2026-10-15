// tools/architecture/test/yaml.test.ts
// 一个文件=一种作用：受限 YAML 子集解析器的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYamlSubset, YamlSubsetError } from '../yaml.js';

test('块映射、块序列与内联流序列都能解析', () => {
  const parsed = parseYamlSubset(
    [
      'version: 1',
      'modules:',
      '  - id: alpha',
      '    roots: [packages/alpha/src]',
      '    managed: true',
      '  - id: beta',
      '    roots:',
      '      - packages/beta/src',
      '    managed: false',
      'global:',
      '  forbidCycles: true',
      '',
    ].join('\n'),
  );

  assert.deepEqual(parsed, {
    version: 1,
    modules: [
      { id: 'alpha', roots: ['packages/alpha/src'], managed: true },
      { id: 'beta', roots: ['packages/beta/src'], managed: false },
    ],
    global: { forbidCycles: true },
  });
});

test('标量形态：单双引号、null、整数、裸字符串', () => {
  const parsed = parseYamlSubset(
    ['a: "双引号"', "b: '单引号'", 'c: null', 'd: -12', 'e: 裸值', 'f: false', ''].join('\n'),
  );
  assert.deepEqual(parsed, {
    a: '双引号',
    b: '单引号',
    c: null,
    d: -12,
    e: '裸值',
    f: false,
  });
});

test('整行注释与行尾注释被忽略，引号内的 # 不当注释', () => {
  const parsed = parseYamlSubset(
    ['# 整行注释', 'id: alpha # 行尾注释', 'label: "a # b"', ''].join('\n'),
  );
  assert.deepEqual(parsed, { id: 'alpha', label: 'a # b' });
});

test('内联流映射与空序列', () => {
  const parsed = parseYamlSubset(['empty: []', 'inline: {a: 1, b: two}', ''].join('\n'));
  assert.deepEqual(parsed, { empty: [], inline: { a: 1, b: 'two' } });
});

test('tab 缩进显式报错，避免静默误读', () => {
  assert.throws(() => parseYamlSubset(['modules:', '\t- id: alpha', ''].join('\n')), YamlSubsetError);
});

test('重复键显式报错', () => {
  assert.throws(() => parseYamlSubset(['id: alpha', 'id: beta', ''].join('\n')), YamlSubsetError);
});

test('未闭合的内联流序列报错', () => {
  assert.throws(() => parseYamlSubset('roots: [a, b\n'), YamlSubsetError);
});
