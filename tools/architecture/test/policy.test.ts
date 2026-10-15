// tools/architecture/test/policy.test.ts
// 一个文件=一种作用：架构策略引擎（依赖边界 / 稳定指纹 / 基线 diff）的验收测试。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  checkArchitecture,
  fingerprint,
  importsOf,
  loadPolicy,
  readBaseline,
  updateBaseline,
  validatePolicy,
} from '../policy.js';

function writeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'awo-arch-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function packageManifest(name: string): string {
  return `${JSON.stringify({ name, main: 'src/index.ts' }, null, 2)}\n`;
}

/** alpha 未声明依赖 beta，却 import 了 beta —— 应报 module-dependency。 */
function undeclaredDependencyFixture(): Record<string, string> {
  return {
    'architecture-policy.yaml': [
      'version: 1',
      'modules:',
      '  - id: alpha',
      '    roots: [packages/alpha/src]',
      '    managed: true',
      '    requires: []',
      '    publicEntrypoints: [packages/alpha/src/index.ts]',
      '    owner: alpha',
      '  - id: beta',
      '    roots: [packages/beta/src]',
      '    managed: true',
      '    requires: []',
      '    publicEntrypoints: [packages/beta/src/index.ts]',
      '    owner: beta',
      'global:',
      '  forbidCycles: true',
      '  forbidDeepImports: true',
      '  managedOnly: true',
      '',
    ].join('\n'),
    'packages/alpha/package.json': packageManifest('@fixture/alpha'),
    'packages/beta/package.json': packageManifest('@fixture/beta'),
    'packages/beta/src/index.ts': 'export const beta = 1;\n',
    'packages/alpha/src/index.ts': "import { beta } from '@fixture/beta';\nexport const alpha = beta;\n",
  };
}

/** 两个模块互相依赖，应报 cycle。 */
function cycleFixture(): Record<string, string> {
  return {
    'architecture-policy.yaml': [
      'version: 1',
      'modules:',
      '  - id: alpha',
      '    roots: [packages/alpha/src]',
      '    managed: true',
      '    requires: [beta]',
      '    publicEntrypoints: [packages/alpha/src/index.ts]',
      '    owner: alpha',
      '  - id: beta',
      '    roots: [packages/beta/src]',
      '    managed: true',
      '    requires: [alpha]',
      '    publicEntrypoints: [packages/beta/src/index.ts]',
      '    owner: beta',
      'global:',
      '  forbidCycles: true',
      '  forbidDeepImports: true',
      '  managedOnly: true',
      '',
    ].join('\n'),
    'packages/alpha/package.json': packageManifest('@fixture/alpha'),
    'packages/beta/package.json': packageManifest('@fixture/beta'),
    'packages/alpha/src/index.ts': "import { beta } from '@fixture/beta';\nexport const alpha = beta;\n",
    'packages/beta/src/index.ts': "import { alpha } from '@fixture/alpha';\nexport const beta = alpha;\n",
  };
}

test('未声明的跨模块依赖被报为 module-dependency', () => {
  const root = writeFixture(undeclaredDependencyFixture());
  try {
    const result = checkArchitecture({ cwd: root });
    const rule = result.violations.filter((violation) => violation.rule === 'module-dependency');
    assert.equal(rule.length, 1, '应恰好报一条 module-dependency');
    assert.equal(rule[0]?.module, 'alpha');
    assert.equal(rule[0]?.detail, 'beta');
    assert.equal(rule[0]?.file, 'packages/alpha/src/index.ts');
    // 无基线时它就是新增违规，必须让检查失败。
    assert.equal(result.newViolations.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模块级循环依赖被报为 cycle', () => {
  const root = writeFixture(cycleFixture());
  try {
    const result = checkArchitecture({ cwd: root });
    const cycles = result.violations.filter((violation) => violation.rule === 'cycle');
    assert.equal(cycles.length, 1, '应恰好报一条 cycle');
    assert.ok(result.violations.every((violation) => violation.rule !== 'module-dependency'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('基线白名单只压制已登记违规，未登记的仍然失败', () => {
  const root = writeFixture(undeclaredDependencyFixture());
  try {
    const before = checkArchitecture({ cwd: root });
    assert.equal(before.newViolations.length, 1);

    const written = updateBaseline(root, before.violations);
    assert.equal(written.violations.length, before.violations.length);
    assert.deepEqual(readBaseline(root), written);

    const after = checkArchitecture({ cwd: root });
    assert.equal(after.violations.length, before.violations.length, '违规总数不变');
    assert.equal(after.baselineViolations.length, before.violations.length, '全部进入基线');
    assert.equal(after.newViolations.length, 0, '基线内的违规不再阻塞');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('指纹不含行号：同一违规上下移动不造成基线漂移', () => {
  const root = writeFixture(undeclaredDependencyFixture());
  try {
    const before = checkArchitecture({ cwd: root });
    const importLine = "import { beta } from '@fixture/beta';\n";
    writeFileSync(
      join(root, 'packages/alpha/src/index.ts'),
      `// 前置注释把 import 下推两行\n\n${importLine}export const alpha = beta;\n`,
    );
    const after = checkArchitecture({ cwd: root });
    assert.equal(
      after.violations[0]?.fingerprint,
      before.violations[0]?.fingerprint,
      '行号变化不应改变指纹',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('指纹区分规则、文件与细节，且长度固定', () => {
  const base = fingerprint('module-dependency', 'packages/a/src/index.ts', 'b');
  assert.equal(base.length, 16);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.notEqual(base, fingerprint('deep-import', 'packages/a/src/index.ts', 'b'));
  assert.notEqual(base, fingerprint('module-dependency', 'packages/c/src/index.ts', 'b'));
  assert.notEqual(base, fingerprint('module-dependency', 'packages/a/src/index.ts', 'c'));
  assert.equal(base, fingerprint('module-dependency', 'packages/a/src/index.ts', 'b'), '同输入必须同指纹');
});

test('策略校验拒绝缺字段与非法 managed 类型', () => {
  assert.throws(() =>
    validatePolicy({
      version: 1,
      modules: [
        { id: 'alpha', roots: [], managed: true, requires: [], publicEntrypoints: [], owner: 'a' },
      ],
      global: { forbidCycles: true, forbidDeepImports: true, managedOnly: true },
    }),
  );
  assert.throws(() =>
    validatePolicy({
      version: 2,
      modules: [],
      global: { forbidCycles: true, forbidDeepImports: true, managedOnly: true },
    }),
  );
});

test('importsOf 覆盖静态 import / re-export / 动态 import', () => {
  const specifiers = importsOf(
    'x.ts',
    [
      "import a from 'one';",
      "export { b } from 'two';",
      "const c = await import('three');",
      "const d = require('four');",
      '',
    ].join('\n'),
  );
  assert.deepEqual(specifiers, ['one', 'two', 'three']);
});

test('真实仓库的策略检查无新增违规（回归护栏）', () => {
  const result = checkArchitecture();
  assert.ok(result.policy.modules.length > 0, '策略必须声明模块');
  assert.deepEqual(
    result.newViolations.map((violation) => violation.fingerprint),
    [],
    `新增架构违规：${result.newViolations.map((violation) => violation.message).join('; ')}`,
  );
});

test('真实仓库的策略文件可加载且声明了 managed 与 legacy 两类模块', () => {
  const policy = loadPolicy();
  assert.ok(policy.modules.some((module) => module.managed), '应存在 managed 模块');
  assert.ok(policy.modules.some((module) => !module.managed), '应存在 legacy 模块');
  assert.equal(policy.global.managedOnly, true);
});
