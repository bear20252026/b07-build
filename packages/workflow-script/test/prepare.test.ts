import assert from 'node:assert/strict';
import test from 'node:test';

import { appendRecord, emptyJournal } from '../src/journal.js';
import { describeEffects, prepareWorkflowRun } from '../src/prepare.js';

// ---------------------------------------------------------------------------
// 运行前的准备：让"能不能跑"只有一个判定点。
// ---------------------------------------------------------------------------

const SCRIPT = `
const researcher = agent('研究员');
await researcher.ask('找出所有 TODO');
await world.run('git', ['status']);
await files.read('README.md');
`;

test('干净的脚本可以开始执行', () => {
  const prepared = prepareWorkflowRun(SCRIPT);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.diagnostics, []);
  assert.deepEqual(prepared.sites.map((site) => site.id), ['actor#1', 'ask#1', 'world-run#1', 'world-read#1']);
});

test('类型检查不过时不收集站点', () => {
  // 类型错乱时站点收集会给出误导性结果（把一个拼错的名字当成"不是效应"），
  // 于是它不在确认清单里 —— 那比不收集更糟。
  const prepared = prepareWorkflowRun('await world.exec("git");\n');
  assert.equal(prepared.ok, false);
  assert.deepEqual(prepared.sites, []);
  assert.ok(prepared.diagnostics.length > 0);
});

test('额度不够时准备阶段就拒绝', () => {
  const prepared = prepareWorkflowRun(SCRIPT, { caps: { maxEffects: 1 } });
  assert.equal(prepared.ok, false);
  assert.match(prepared.diagnostics[0]?.message ?? '', /额度/);
});

test('续跑时用上一轮的journal判额度', () => {
  const journal = appendRecord(emptyJournal('run-1'), 'ask#1', 1, '结果').journal;
  const prepared = prepareWorkflowRun(SCRIPT, { journal, caps: { maxEffects: 3 } });
  // 3 个效应站点、额度 3、已用 1 → 还能跑。
  assert.equal(prepared.ok, true);
});

test('确认清单只列效应站点', () => {
  const prepared = prepareWorkflowRun(SCRIPT);
  const effects = describeEffects(prepared.sites);
  // 创建子代理本身不改变外部世界；把它列进"会做什么"会让清单变噪音，
  // 而噪音会让用户不再细看。
  assert.equal(effects.length, 3);
  assert.ok(effects.every((line) => !line.includes('actor#1')));
  assert.ok(effects.some((line) => line.includes('跑命令')));
  assert.ok(effects.some((line) => line.includes('派活')));
  assert.ok(effects.some((line) => line.includes('读工作区')));
});

test('确认清单带行号与标签', () => {
  const prepared = prepareWorkflowRun(`await world.run('git', ['status']);\n`);
  assert.deepEqual(describeEffects(prepared.sites), ['跑命令 world-run#1（第 1 行）：git']);
});

test('空脚本可以开始执行且没有效应', () => {
  const prepared = prepareWorkflowRun('');
  assert.equal(prepared.ok, true);
  assert.deepEqual(describeEffects(prepared.sites), []);
});

test('不传journal也照样判额度', () => {
  // 静态站点数是否超额与历史无关。若"没传 journal 就完全没闸门"，
  // 那正是最容易漏掉的一条路径 —— 漏掉的后果是效应已经发生之后才发现超限。
  assert.equal(prepareWorkflowRun(SCRIPT, { caps: { maxEffects: 1 } }).ok, false);
  assert.equal(prepareWorkflowRun(SCRIPT, { caps: { maxEffects: 3 } }).ok, true);
  assert.equal(prepareWorkflowRun(SCRIPT).ok, true, '不传 caps 时用宽松默认');
});
