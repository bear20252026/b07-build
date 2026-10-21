import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkflowProgram } from '../src/compile.js';
import { collectSites } from '../src/sites.js';
import {
  EFFECT_BUDGET_EXCEEDED_CODE,
  appendRecord,
  checkCaps,
  emptyJournal,
  isValidJournalRecord,
  journalKey,
  journalSummary,
  recordedResult,
  remainingEffects,
  usedEffects,
} from '../src/journal.js';

// ---------------------------------------------------------------------------
// journal：续跑**不重跑**已经做过的效应。四条不变式各对应一个静默失败。
// ---------------------------------------------------------------------------

const RUN = 'run-1';

test('记录后能查回同一个结果', () => {
  const journal = appendRecord(emptyJournal(RUN), 'world-run#1', 1, { exitCode: 0 }).journal;
  assert.deepEqual(recordedResult(journal, 'world-run#1', 1), { kind: 'recorded', result: { exitCode: 0 } });
});

test('没记录过就是missing（驱动层据此执行）', () => {
  assert.deepEqual(recordedResult(emptyJournal(RUN), 'world-run#1', 1), { kind: 'missing' });
});

test('不变式1：键包含第几次，否则循环里的第二次会复用第一次', () => {
  // 只有站点身份做键时，`for (…) await world.run(…)` 的第二次执行会拿到第一次的结果 ——
  // 一条命令跑两次只算一次，而调用方以为跑了两次。
  const journal = appendRecord(emptyJournal(RUN), 'world-run#1', 1, '第一次').journal;
  assert.deepEqual(recordedResult(journal, 'world-run#1', 2), { kind: 'missing' });
});

test('不变式1：站点身份含#，拼键不能撞', () => {
  // `ask#1` + `2` 与 `ask#12` + `` 拼起来都是 `ask#12`；用 @ 分隔才不会撞。
  assert.notEqual(journalKey('ask#1', 2), journalKey('ask#12', 1));
  assert.equal(journalKey('ask#1', 2), 'ask#1@2');
});

test('不变式2：attempt必须是正整数', () => {
  // 0 基与 1 基混用会让续跑找不到记录，于是**重跑**效应 ——
  // 这是最危险的一种，因为它看起来只是"少了一次复用"。
  for (const attempt of [0, -1, 1.5, Number.NaN]) {
    assert.equal(
      isValidJournalRecord({ siteId: 'ask#1', attempt, result: null }),
      false,
      `attempt=${attempt} 应被判为非法`,
    );
  }
  assert.equal(isValidJournalRecord({ siteId: 'ask#1', attempt: 1, result: null }), true);
});

test('不变式2：siteId不能为空', () => {
  for (const siteId of ['', '   ']) {
    assert.equal(isValidJournalRecord({ siteId, attempt: 1, result: null }), false);
  }
  assert.equal(isValidJournalRecord({ siteId: 'ask#1', attempt: 1, result: null }), true);
});

test('不变式3：只追加不覆盖', () => {
  // 允许覆盖就等于允许改写历史，而历史是续跑判断的全部依据。
  const first = appendRecord(emptyJournal(RUN), 'world-run#1', 1, '甲');
  const second = appendRecord(first.journal, 'world-run#1', 1, '乙');
  assert.equal(second.appended, false, '同键第二次追加应被拒绝');
  assert.deepEqual(recordedResult(second.journal, 'world-run#1', 1), { kind: 'recorded', result: '甲' });
  assert.equal(second.journal.records.length, 1, '不应多出一条');
});

test('追加不修改原journal', () => {
  // 纯函数：原对象保持不变，否则"上一轮的记录"会被悄悄改掉。
  const before = emptyJournal(RUN);
  appendRecord(before, 'ask#1', 1, 'x');
  assert.equal(before.records.length, 0);
});

test('不同站点的记录互不影响', () => {
  let journal = emptyJournal(RUN);
  journal = appendRecord(journal, 'ask#1', 1, '甲').journal;
  journal = appendRecord(journal, 'ask#2', 1, '乙').journal;
  assert.deepEqual(recordedResult(journal, 'ask#1', 1), { kind: 'recorded', result: '甲' });
  assert.deepEqual(recordedResult(journal, 'ask#2', 1), { kind: 'recorded', result: '乙' });
});

// ---------------------------------------------------------------------------
// 摘要与额度
// ---------------------------------------------------------------------------

const SCRIPT = `
const a = agent('甲');
await a.ask('一');
await a.ask('二');
await world.run('git', ['status']);
await files.read('README.md');
`;

function sitesOf(source: string) {
  return collectSites(createWorkflowProgram(source)).sites;
}

test('摘要按站点报已记录次数', () => {
  const sites = sitesOf(SCRIPT);
  let journal = emptyJournal(RUN);
  journal = appendRecord(journal, 'ask#1', 1, '甲').journal;
  journal = appendRecord(journal, 'ask#1', 2, '乙').journal;
  const summary = journalSummary(journal, sites);
  assert.deepEqual(
    summary.map((item) => `${item.site.id}:${item.attempts}`),
    ['actor#1:0', 'ask#1:2', 'ask#2:0', 'world-run#1:0', 'world-read#1:0'],
  );
});

test('创建子代理不占效应额度', () => {
  // actor 只是建一个子代理，真正的活在 ask 上。把 actor 也算进额度，
  // 会让"起五个研究员并行"这种完全正常的脚本先被额度挡住。
  const sites = sitesOf(SCRIPT);
  assert.equal(sites.filter((site) => site.kind === 'actor').length, 1);
  assert.equal(usedEffects(emptyJournal(RUN), sites), 0);
});

test('不变式4：静态站点数就超额时整次拒绝', () => {
  const sites = sitesOf(SCRIPT);
  const diagnostics = checkCaps(sites, emptyJournal(RUN), { maxEffects: 2 });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, EFFECT_BUDGET_EXCEEDED_CODE);
  // 报的位置是**第一个越界的站点**，用户能直接跳过去。
  assert.equal(diagnostics[0]?.line, sites[3]?.line);
});

test('已用尽额度时拒绝继续', () => {
  // 刻意用一个**静态站点数不超额**的脚本：否则先被上面那条"静态就超额"挡住，
  // 这条路径（额度在运行中被用完）就测不到。
  const small = sitesOf(`const a = agent('甲');\nawait a.ask('一');\nawait a.ask('二');\n`);
  assert.equal(small.filter((site) => site.kind !== 'actor').length, 2, '应有两个效应站点');
  let journal = emptyJournal(RUN);
  journal = appendRecord(journal, 'ask#1', 1, '甲').journal;
  journal = appendRecord(journal, 'ask#2', 1, '乙').journal;
  const diagnostics = checkCaps(small, journal, { maxEffects: 2 });
  assert.equal(diagnostics[0]?.code, EFFECT_BUDGET_EXCEEDED_CODE);
  assert.match(diagnostics[0]?.message ?? '', /已用尽/);
});

test('额度够时没有诊断', () => {
  const sites = sitesOf(SCRIPT);
  assert.deepEqual(checkCaps(sites, emptyJournal(RUN), { maxEffects: 10 }), []);
});

test('剩余额度按已执行次数递减', () => {
  const sites = sitesOf(SCRIPT);
  let journal = emptyJournal(RUN);
  assert.equal(remainingEffects(journal, sites, { maxEffects: 5 }), 5);
  journal = appendRecord(journal, 'ask#1', 1, '甲').journal;
  assert.equal(remainingEffects(journal, sites, { maxEffects: 5 }), 4);
  // 同一站点第二次执行也占额度：额度数的是**效应次数**，不是站点数。
  journal = appendRecord(journal, 'ask#1', 2, '乙').journal;
  assert.equal(remainingEffects(journal, sites, { maxEffects: 5 }), 3);
});

test('额度必须是正整数', () => {
  const sites = sitesOf(SCRIPT);
  for (const maxEffects of [0, -1, 1.5]) {
    const diagnostics = checkCaps(sites, emptyJournal(RUN), { maxEffects });
    assert.equal(diagnostics[0]?.code, EFFECT_BUDGET_EXCEEDED_CODE, `maxEffects=${maxEffects}`);
  }
});

test('空脚本不占额度也不需要额度', () => {
  assert.deepEqual(checkCaps([], emptyJournal(RUN), { maxEffects: 1 }), []);
});
