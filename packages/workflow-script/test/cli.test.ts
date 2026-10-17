import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKFLOW_CLI_DIAGNOSTICS, WORKFLOW_CLI_OK, WORKFLOW_CLI_USAGE, runWorkflowScriptCli } from '../src/cli.js';

// ---------------------------------------------------------------------------
// 校验器 CLI：驱动层落地之前，作者仍能知道"脚本会不会做危险的事"。
// ---------------------------------------------------------------------------

/** 跑一次 CLI 并收集输出。 */
async function run(argv: readonly string[], files: Readonly<Record<string, string>> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runWorkflowScriptCli(argv, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, {
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path]!;
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const CLEAN = `
const researcher = agent('研究员');
await researcher.ask('找出所有 TODO');
await world.run('git', ['status']);
`;

test('干净脚本退出码 0 并列出效应', async () => {
  const result = await run(['check', 'w.ts'], { 'w.ts': CLEAN });
  assert.equal(result.code, WORKFLOW_CLI_OK);
  assert.match(result.out, /脚本检查通过/);
  assert.match(result.out, /跑命令 world-run#1/);
  assert.match(result.out, /派活 ask#1/);
});

test('明说只校验不执行', async () => {
  // 不说清楚，用户会以为它跑过了。
  const result = await run(['check', 'w.ts'], { 'w.ts': CLEAN });
  assert.match(result.out, /不会执行脚本/);
});

test('类型错误退出码 1 并带行列', async () => {
  const result = await run(['check', 'w.ts'], { 'w.ts': "log('ok');\nlog(undefinedName);\n" });
  assert.equal(result.code, WORKFLOW_CLI_DIAGNOSTICS);
  assert.match(result.out, /2:5/);
  assert.match(result.out, /undefinedName/);
});

test('非字面量命令被报出来', async () => {
  const result = await run(['check', 'w.ts'], { 'w.ts': "const cmd = 'git';\nawait world.run(cmd);\n" });
  assert.equal(result.code, WORKFLOW_CLI_DIAGNOSTICS);
  assert.match(result.out, /workflow-non-literal-command/);
});

test('额度不够时退出码 1', async () => {
  const result = await run(['check', 'w.ts', '--max-effects', '1'], { 'w.ts': CLEAN });
  assert.equal(result.code, WORKFLOW_CLI_DIAGNOSTICS);
  assert.match(result.out, /额度/);
});

test('effects只打效应清单', async () => {
  const result = await run(['effects', 'w.ts'], { 'w.ts': CLEAN });
  assert.equal(result.code, WORKFLOW_CLI_OK);
  assert.match(result.out, /这次运行会做/);
  assert.equal(result.out.includes('脚本检查通过'), false);
});

test('effects在诊断时拒绝给出清单而不是给一份漏东西的', async () => {
  // 类型不干净时站点表会被刻意置空：拼错的名字会被当成"不是效应"，
  // 清单看着完整、其实漏了东西 —— 那比不给更危险。
  const result = await run(['effects', 'w.ts'], { 'w.ts': "log(undefinedName);\nawait world.run('git');\n" });
  assert.equal(result.code, WORKFLOW_CLI_DIAGNOSTICS);
  assert.match(result.err, /无法给出可靠的效应清单/);
  assert.match(result.err, /undefinedName/);
  assert.equal(result.out.includes('跑命令'), false, '不该给一份漏东西的清单');
});

test('无效应时明确说没有', async () => {
  const result = await run(['effects', 'w.ts'], { 'w.ts': "log('只是日志');\n" });
  assert.match(result.out, /没有任何有副作用的操作/);
});

test('json输出可直接被机器读', async () => {
  const result = await run(['check', 'w.ts', '--json'], { 'w.ts': CLEAN });
  const parsed = JSON.parse(result.out) as { ok: boolean; diagnostics: unknown[]; sites: { id: string }[]; effects: string[] };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.sites.map((site) => site.id), ['actor#1', 'ask#1', 'world-run#1']);
  assert.equal(parsed.effects.length, 2);
});

test('用法错误退出码 2', async () => {
  for (const argv of [[], ['nope', 'w.ts'], ['check'], ['check', 'w.ts', '--bogus'], ['check', 'w.ts', '--max-effects', '0'], ['check', 'w.ts', '--max-effects', 'abc'], ['check', 'w.ts', 'extra']]) {
    const result = await run(argv as string[], { 'w.ts': CLEAN });
    assert.equal(result.code, WORKFLOW_CLI_USAGE, `argv=${JSON.stringify(argv)}`);
    assert.ok(result.err.length > 0, '用法错误应写 stderr');
  }
});

test('读不到文件退出码 2', async () => {
  const result = await run(['check', 'missing.ts']);
  assert.equal(result.code, WORKFLOW_CLI_USAGE);
  assert.match(result.err, /读不到脚本/);
});
