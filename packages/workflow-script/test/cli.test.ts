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

// ---------------------------------------------------------------------------
// run：真的执行脚本。
//
// 与 check/effects 的关键区别：run 需要执行端口（runtime），缺了要明确报错
// 而不是伪造一个"跑过了"的结果。
// ---------------------------------------------------------------------------

import type { WorkflowJournal } from '../src/journal.js';
import type { WorkflowJournalStore, WorkflowRuntime } from '../src/runner.js';

/** 一个内存 runtime，记录调用并可指定返回值。 */
function makeRuntime(overrides: Partial<WorkflowRuntime> = {}) {
  const calls: string[] = [];
  const runtime: WorkflowRuntime = {
    log: () => {},
    run: async (cmd, args) => {
      calls.push(`run:${cmd}:${args.join(' ')}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    glob: async (pattern) => {
      calls.push(`glob:${pattern}`);
      return [];
    },
    read: async (path) => {
      calls.push(`read:${path}`);
      return '';
    },
    grep: async (pattern) => {
      calls.push(`grep:${pattern}`);
      return [];
    },
    ask: async (instructions) => {
      calls.push(`ask:${instructions}`);
      return null;
    },
    ...overrides,
  };
  return { runtime, calls };
}

/** 跑一次 run 子命令。 */
async function runRun(
  argv: readonly string[],
  files: Readonly<Record<string, string>>,
  runtime: WorkflowRuntime,
  journalStore?: WorkflowJournalStore,
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runWorkflowScriptCli(
    argv,
    { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    {
      readFile: (path) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return files[path]!;
      },
    },
    { runtime, journalStore },
  );
  return { code, out: out.join(''), err: err.join('') };
}

test('run 真的执行效应并报告新增记录', async () => {
  const { runtime, calls } = makeRuntime();
  const result = await runRun(['run', 'w.ts'], { 'w.ts': CLEAN }, runtime);
  assert.equal(result.code, WORKFLOW_CLI_OK);
  assert.match(result.out, /运行完成/);
  assert.match(result.out, /本轮新增 2 条/);
  assert.ok(calls.includes('run:git:status'), '命令真的跑了');
  assert.ok(calls.some((line) => line.startsWith('ask:')), '派活真的发生了');
});

test('run 缺执行端口时退出码 2，不伪造执行', async () => {
  // 关键：不能返回 0 让用户以为跑过了。
  const out: string[] = [];
  const err: string[] = [];
  const code = await runWorkflowScriptCli(
    ['run', 'w.ts'],
    { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    { readFile: () => CLEAN },
  );
  assert.equal(code, WORKFLOW_CLI_USAGE);
  assert.match(err.join(''), /需要执行端口/);
  assert.equal(out.join(''), '', '不该报告任何"跑过了"的输出');
});

test('run 在诊断时拒绝执行（不做出未批准的效应）', async () => {
  const { runtime, calls } = makeRuntime();
  const result = await runRun(['run', 'w.ts'], { 'w.ts': "log(undefinedName);\nawait world.run('git');\n" }, runtime);
  assert.equal(result.code, WORKFLOW_CLI_DIAGNOSTICS);
  assert.match(result.err, /拒绝执行/);
  assert.deepEqual(calls, [], '一个效应都不该跑');
});

test('run 的 json 输出含逐站点结果', async () => {
  const { runtime } = makeRuntime();
  const result = await runRun(['run', 'w.ts', '--json'], { 'w.ts': CLEAN }, runtime);
  const parsed = JSON.parse(result.out) as {
    completed: boolean;
    outcomes: { siteId: string; attempt: number; reused: boolean }[];
    appended: unknown;
  };
  assert.equal(parsed.completed, true);
  assert.deepEqual(
    parsed.outcomes.map((entry) => `${entry.siteId}:${entry.attempt}:${entry.reused}`),
    ['ask#1:1:false', 'world-run#1:1:false'],
  );
});

test('run 不落盘时也能跑（journalStore 可选）', async () => {
  const { runtime, calls } = makeRuntime();
  const result = await runRun(['run', 'w.ts'], { 'w.ts': CLEAN }, runtime);
  assert.equal(result.code, WORKFLOW_CLI_OK);
  assert.ok(calls.length > 0);
});

test('run 只在有新增时落盘', async () => {
  let saved = 0;
  const { runtime } = makeRuntime();
  const store = { load: () => undefined, save: () => { saved += 1; } };
  await runRun(['run', 'w.ts'], { 'w.ts': CLEAN }, runtime, store);
  assert.equal(saved, 1, '有新增要落盘');
});

test('run 的 journal 路径进了 runId', async () => {
  // runId 是 journal 的身份，续跑时靠它区分"哪一轮"。--journal 给的路径应当
  // 成为它，而不是再生成一个时间戳。
  const { runtime } = makeRuntime();
  let saved: WorkflowJournal | undefined;
  await runRun(['run', 'w.ts', '--journal', 'j.json'], { 'w.ts': CLEAN }, runtime, {
    load: () => undefined,
    save: (journal) => { saved = journal; },
  });
  assert.equal(saved?.runId, 'j.json');
});

test('run 两次：第二次从 store 续跑，效应不重做', async () => {
  // 端到端续跑钉。runner 曾只调 save 从不调 load，于是每次跑都重做所有效应 ——
  // 这个测试在 CLI 层把那条路径钉住（CLI 只传 store，不传 journal）。
  const { runtime, calls } = makeRuntime();
  let stored: WorkflowJournal | undefined;
  const store: WorkflowJournalStore = {
    load: () => stored,
    save: (journal) => { stored = journal; },
  };
  const files = { 'w.ts': "await world.run('git', ['status']);\n" };

  const first = await runRun(['run', 'w.ts', '--journal', 'j.json'], files, runtime, store);
  assert.equal(first.code, WORKFLOW_CLI_OK);
  assert.match(first.out, /本轮新增 1 条/);
  assert.equal(calls.length, 1);

  const second = await runRun(['run', 'w.ts', '--journal', 'j.json'], files, runtime, store);
  assert.equal(second.code, WORKFLOW_CLI_OK);
  assert.match(second.out, /本轮新增 0 条/);
  assert.equal(calls.length, 1, '第二次不该重跑任何命令');
});

test('run 用法错误退出码 2', async () => {
  const { runtime } = makeRuntime();
  for (const argv of [['run'], ['run', 'w.ts', '--journal'], ['run', 'w.ts', '--bogus']]) {
    const result = await runRun(argv as string[], { 'w.ts': CLEAN }, runtime);
    assert.equal(result.code, WORKFLOW_CLI_USAGE, `argv=${JSON.stringify(argv)}`);
  }
});
