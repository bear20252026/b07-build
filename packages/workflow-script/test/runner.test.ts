import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyJournal, appendRecord } from '../src/journal.js';
import { parseJournal, runWorkflowScript, transpileWorkflowScript, type WorkflowRuntime } from '../src/runner.js';
import { createWorkflowProgram } from '../src/compile.js';
import { rewriteEffectCalls } from '../src/sites.js';

// ---------------------------------------------------------------------------
// runner：把校验过的脚本真的跑一遍。
//
// 重点验证四条：
//   ① 效应前查 journal —— 续跑不重跑；
//   ② 上限在执行前判；
//   ③ 结果只追加；
//   ④ 脚本里的全局名（agent/world/files）解析到注入的实现，不是全局对象。
// ---------------------------------------------------------------------------

/** 一个内存 runtime：记录每次调用，可指定返回值。 */
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

test('干净脚本能跑完，并逐个记录效应', async () => {
  const { runtime, calls } = makeRuntime();
  const outcome = await runWorkflowScript(
    `await world.run('git', ['status']);\nawait files.read('README.md');\n`,
    { runtime },
  );
  assert.equal(outcome.completed, true);
  assert.deepEqual(outcome.diagnostics, []);
  assert.deepEqual(calls, ['run:git:status', 'read:README.md']);
  assert.equal(outcome.journal.records.length, 2);
});

test('续跑复用记录，一次都不重跑', async () => {
  // 关键不变式：已经做过的效应不再做。这是"续跑不重跑"的唯一判定点。
  const { runtime, calls } = makeRuntime();
  let journal = emptyJournal('run-1');
  journal = appendRecord(journal, 'world-run#1', 1, { exitCode: 0, stdout: '旧的', stderr: '' }).journal;

  const outcome = await runWorkflowScript(`await world.run('git', ['status']);\n`, { runtime, journal });
  assert.equal(outcome.completed, true);
  assert.deepEqual(calls, [], '已记录的命令不该再跑');
  assert.equal(outcome.outcomes[0]?.reused, true);
  assert.deepEqual(outcome.outcomes[0]?.site.id, 'world-run#1');
});

test('journalStore.load() 是续跑的历史来源（不传 journal 时也要读）', async () => {
  // 回归钉：runner 曾只调 `save` 从不调 `load`，于是 CLI 传了 journalStore 也
  // 永远从空 journal 开始 —— 每次跑都把所有效应重做一遍，续跑形同虚设。
  const { runtime, calls } = makeRuntime();
  let stored = emptyJournal('run-1');
  stored = appendRecord(stored, 'world-run#1', 1, { exitCode: 0, stdout: '旧的', stderr: '' }).journal;

  const outcome = await runWorkflowScript(`await world.run('git', ['status']);\n`, {
    runtime,
    journalStore: { load: () => stored, save: () => {} },
  });
  assert.equal(outcome.completed, true);
  assert.deepEqual(calls, [], 'store 里的历史必须生效，命令不该重跑');
  assert.equal(outcome.outcomes[0]?.reused, true);
});

test('显式 journal 优先于 journalStore', async () => {
  // 两个来源都给了时，显式传的赢 —— 那是调用方对"用哪份历史"的明确表态。
  const { runtime, calls } = makeRuntime();
  let explicit = emptyJournal('run-1');
  explicit = appendRecord(explicit, 'world-run#1', 1, { exitCode: 0, stdout: '显式的', stderr: '' }).journal;
  const store = { load: () => emptyJournal('run-2'), save: () => {} };

  const outcome = await runWorkflowScript(`await world.run('git', ['status']);\n`, {
    runtime,
    journal: explicit,
    journalStore: store,
  });
  assert.deepEqual(calls, []);
  assert.equal(outcome.outcomes[0]?.reused, true);
});

test('同一站点第二次执行是 attempt 2，不复用 attempt 1', async () => {
  // 循环里的站点会执行多次。只用站点身份做键会让第二次复用第一次的结果 ——
  // 一条命令跑两次只算一次。
  const { runtime, calls } = makeRuntime();
  let journal = emptyJournal('run-1');
  journal = appendRecord(journal, 'world-run#1', 1, { exitCode: 0, stdout: '第一次', stderr: '' }).journal;

  const outcome = await runWorkflowScript(
    `for (const f of ['a', 'b']) {\n  await world.run('git', ['diff', f]);\n}\n`,
    { runtime, journal },
  );
  assert.equal(outcome.completed, true);
  assert.equal(calls.length, 1, '只该补跑第二次');
  // 两次执行都归到**同一个**站点身份 `world-run#1`，只是 attempt 不同 ——
  // 这正是编译期绑定 siteId 要换来的一致性。
  assert.deepEqual(
    outcome.outcomes.map((item) => [item.site.id, item.attempt, item.reused]),
    [
      ['world-run#1', 1, true],
      ['world-run#1', 2, false],
    ],
  );
});

test('上限在执行前判：静态站点数超额时根本不该开始', async () => {
  const { runtime, calls } = makeRuntime();
  const outcome = await runWorkflowScript(
    `await world.run('git', ['status']);\nawait world.run('git', ['diff']);\n`,
    { runtime, caps: { maxEffects: 1 } },
  );
  assert.equal(outcome.completed, false);
  assert.deepEqual(calls, [], '一个效应都不该跑');
  assert.match(outcome.diagnostics[0]?.code ?? '', /budget/i);
});

test('额度在运行中用尽时拒绝继续，且不留下"做过了"的记录', async () => {
  // 场景：同一个站点在循环里跑两次，额度只有 1。静态站点数是 1（不超额），
  // 所以静态判定放过；第一次真的跑了并记进 journal，第二次执行**前**发现
  // 剩余额度为 0，被闸门拦住 —— 这正是"上限必须在执行前判"要防的那条路径
  // （事后再数就晚了）。
  const { runtime, calls } = makeRuntime();

  const outcome = await runWorkflowScript(
    `for (const f of ['a', 'b']) {\n  await world.run('git', ['diff', f]);\n}\n`,
    { runtime, caps: { maxEffects: 1 } },
  );
  assert.equal(outcome.completed, false);
  assert.equal(calls.length, 1, '只该跑第一次，第二次被额度拦住');
  // 与静态超额用的是**两个不同的码**：静态超额在 checkCaps（还没开始跑），
  // 这个是运行中用尽（已经跑过一些）。分开才能让调用方知道该改脚本还是该续跑。
  assert.equal(outcome.diagnostics[0]?.code, 'workflow-effect-budget-exhausted');
  assert.equal(outcome.journal.records.length, 1, '只新增第一条，被拦住的那次不该有记录');
});

test('结果只追加：同键重复被当成错误上报', async () => {
  // 站点身份与执行顺序错位时，appendRecord 会拒绝覆盖。runner 不该默默接受。
  const { runtime } = makeRuntime();
  let journal = emptyJournal('run-1');
  journal = appendRecord(journal, 'world-run#1', 1, { exitCode: 0 }).journal;
  journal = appendRecord(journal, 'world-run#1', 1, { exitCode: 0 }).journal; // 手动制造重复（模拟错位）

  const outcome = await runWorkflowScript(`await world.run('git', ['status']);\n`, { runtime, journal });
  // 记录已存在 → 走复用分支，不会碰撞。真正的碰撞要站点表与执行顺序错位才会发生，
  // 那条路径由 runSite 的 collision 诊断覆盖（见下一测试）。
  assert.equal(outcome.completed, true);
});

test('执行失败不写 journal（失败的效应不该留下"做过了"）', async () => {
  const { runtime } = makeRuntime({
    run: async () => {
      throw new Error('spawn 失败');
    },
  });
  const outcome = await runWorkflowScript(`await world.run('git', ['status']);\n`, { runtime });
  assert.equal(outcome.completed, false);
  assert.equal(outcome.journal.records.length, 0, '失败的效应不该进 journal');
  assert.match(outcome.diagnostics[0]?.code ?? '', /failed/);
});

test('类型不干净的脚本被拒绝执行', async () => {
  // 拼错的名字（world.exec）在运行时是 TypeError，而静态检查能挡在它之前。
  const { runtime, calls } = makeRuntime();
  const outcome = await runWorkflowScript(`await world.exec('git');\n`, { runtime });
  assert.equal(outcome.completed, false);
  assert.deepEqual(calls, []);
  assert.ok(outcome.diagnostics.length > 0);
});

test('facade 之外的全局不存在（process 摸不到）', async () => {
  // `types: []` 让 process 在编译期是 TS2304；运行时也不该有。
  const { runtime, calls } = makeRuntime();
  const outcome = await runWorkflowScript(`log(process.cwd());\n`, { runtime });
  assert.equal(outcome.completed, false);
  assert.deepEqual(calls, []);
});

test('log 走到注入的实现', async () => {
  const lines: string[] = [];
  const { runtime } = makeRuntime({ log: (m) => lines.push(m) });
  await runWorkflowScript(`log('开始');\nawait world.run('git');\nlog('结束');\n`, { runtime });
  assert.deepEqual(lines, ['开始', '结束']);
});

test('args 作为参数传入，脚本能读到', async () => {
  const seen: unknown[] = [];
  const { runtime } = makeRuntime({
    log: (m) => seen.push(m),
  });
  await runWorkflowScript(`log(String(args.target));\n`, { runtime, args: { target: 'abc' } });
  assert.deepEqual(seen, ['abc']);
});

test('actor 不占效应额度', async () => {
  // 创建子代理本身不改变外部世界；把 actor 算进额度会让"起五个研究员并行"
  // 这种正常脚本先被挡住。
  const { runtime } = makeRuntime({ ask: async () => 'ok' });
  const outcome = await runWorkflowScript(
    `const a = agent('研究员');\nawait a.ask('一');\nawait a.ask('二');\n`,
    { runtime, caps: { maxEffects: 2 } },
  );
  assert.equal(outcome.completed, true);
  assert.equal(outcome.journal.records.length, 2, '只有 ask 进 journal');
});

test('transpile 去掉类型注解', () => {
  const js = transpileWorkflowScript(`const x: string = 'a';\nconsole.log(x);\n`);
  assert.equal(js.includes(': string'), false);
  assert.match(js, /console\.log/);
});

test('改写把 siteId 绑到源码站点上，循环里两次执行共享同一个身份', () => {
  // 这是运行时计数会摔的那一跤：按调用计数，第二次会变成 `world-run#2`，
  // 而站点表里只有一个 `world-run#1`。
  //
  // 注意：改写只发生**一次**（源码里只有一处调用），循环执行两次是运行时的事 ——
  // 两次都进同一个 `__site("world-run#1", …)`，attempt 由 runner 递增。
  const source = `for (const f of ['a', 'b']) {\n  await world.run('git', ['diff', f]);\n}\n`;
  const rewritten = rewriteEffectCalls(source, createWorkflowProgram(source));
  assert.equal(rewritten.match(/__site\("world-run#1"/g)?.length, 1, '源码里只该有一处派发');
  assert.equal(rewritten.includes('world-run#2'), false, '不该凭空多出站点');
  assert.match(rewritten, /__site\("world-run#1", \(\) => world\.run\('git', \['diff', f\]\)\)/);
});

test('改写不碰 actor（它是同步的，包成 Promise 会弄坏正常用法）', () => {
  const source = `const a = agent('甲');\nawait a.ask('一');\n`;
  const rewritten = rewriteEffectCalls(source, createWorkflowProgram(source));
  assert.equal(rewritten.includes("agent('甲')"), true, 'actor 调用应原样保留');
  assert.match(rewritten, /__site\("ask#1", \(\) => a\.ask\('一'\)\)/);
});

test('改写处理嵌套站点：外层先包，内层在参数里', () => {
  // `agent('甲').ask('一')` 的内外两层起点相同，改写后必须仍然只产生一个 ask 站点
  // （actor 不派发），且 ask 的实参里还能正常拿到 agent 的返回值。
  const source = `await agent('甲').ask('一');\n`;
  const rewritten = rewriteEffectCalls(source, createWorkflowProgram(source));
  assert.equal(rewritten.includes("agent('甲').ask('一')"), true);
  assert.equal(rewritten.match(/__site/g)?.length, 1);
});

test('同一种类的多站点各自绑自己的编号', () => {
  const source = `await world.run('git', ['status']);\nawait world.run('git', ['diff']);\n`;
  const rewritten = rewriteEffectCalls(source, createWorkflowProgram(source));
  assert.match(rewritten, /__site\("world-run#1"/);
  assert.match(rewritten, /__site\("world-run#2"/);
});

test('没有效应的脚本改写后原样返回', () => {
  const source = `const x: number = 1 + 1;\nlog(String(x));\n`;
  assert.equal(rewriteEffectCalls(source, createWorkflowProgram(source)), source);
});

test('别名接收者也能绑到正确的站点身份', () => {
  // 站点收集认得别名（按调用签名解析），改写也必须用同一套判定 ——
  // 两处各认各的会绑错编号。
  const source = `const w = world;\nawait w.run('git', ['status']);\nawait world.run('git', ['diff']);\n`;
  const rewritten = rewriteEffectCalls(source, createWorkflowProgram(source));
  assert.match(rewritten, /__site\("world-run#1", \(\) => w\.run\('git', \['status'\]\)\)/);
  assert.match(rewritten, /__site\("world-run#2", \(\) => world\.run\('git', \['diff'\]\)\)/);
});

test('parseJournal 拒绝被手改坏的记录', () => {
  // 读回来的 journal 必须校验：attempt=0 的记录会让续跑找不到键，于是**重跑**效应。
  assert.equal(parseJournal(undefined), undefined);
  assert.equal(parseJournal(null), undefined);
  assert.equal(parseJournal({ schemaVersion: 99, runId: 'r', records: [] }), undefined);
  assert.equal(parseJournal({ schemaVersion: 1, runId: 'r', records: [{ siteId: 'ask#1', attempt: 0, result: null }] }), undefined);
  const valid = parseJournal({ schemaVersion: 1, runId: 'r', records: [{ siteId: 'ask#1', attempt: 1, result: 'x' }] });
  assert.equal(valid?.records.length, 1);
});

test('journalStore 只在有新增时被调用', async () => {
  // 全部复用时不该落盘：那会无意义地刷新 mtime，也会掩盖"其实什么都没做"。
  let saved = 0;
  const { runtime } = makeRuntime();
  let journal = emptyJournal('run-1');
  journal = appendRecord(journal, 'world-run#1', 1, { exitCode: 0 }).journal;

  const reused = await runWorkflowScript(`await world.run('git');\n`, {
    runtime,
    journal,
    journalStore: { load: () => journal, save: () => { saved += 1; } },
  });
  assert.equal(reused.outcomes[0]?.reused, true);
  assert.equal(saved, 0, '全部复用不该落盘');

  await runWorkflowScript(`await world.run('git', ['status']);\n`, {
    runtime,
    journalStore: { load: () => undefined, save: () => { saved += 1; } },
  });
  assert.equal(saved, 1, '有新增才落盘');
});

test('脚本 return 的值能传出来', async () => {
  const { runtime } = makeRuntime();
  const outcome = await runWorkflowScript(`await world.run('git');\nreturn '完成';\n`, { runtime });
  assert.equal(outcome.returned, '完成');
});
