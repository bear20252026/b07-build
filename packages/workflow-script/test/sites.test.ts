import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkflowProgram } from '../src/compile.js';
import { NON_LITERAL_COMMAND_CODE, collectSites } from '../src/sites.js';

// ---------------------------------------------------------------------------
// 站点收集：运行前就知道脚本会做哪些有副作用的事，且每个站点有稳定身份。
// ---------------------------------------------------------------------------

function sitesOf(source: string) {
  return collectSites(createWorkflowProgram(source));
}

test('收集四种站点并按源码顺序排列', () => {
  const table = sitesOf(`
const researcher = agent('研究员');
await researcher.ask('找 TODO');
await files.glob('src/**/*.ts');
await world.run('git', ['status']);
`);
  assert.deepEqual(table.sites.map((site) => site.id), ['actor#1', 'ask#1', 'world-read#1', 'world-run#1']);
  assert.deepEqual(table.sites.map((site) => site.kind), ['actor', 'ask', 'world-read', 'world-run']);
  assert.deepEqual(table.diagnostics, []);
});

test('同类站点按源码顺序各自计数', () => {
  const table = sitesOf(`
const a = agent('甲');
const b = agent('乙');
await a.ask('一');
await b.ask('二');
await a.ask('三');
`);
  assert.deepEqual(table.sites.map((site) => site.id), ['actor#1', 'actor#2', 'ask#1', 'ask#2', 'ask#3']);
});

test('新增一种站点不会挪动另一种的编号', () => {
  // 这是"按种类计数"存在的**唯一理由**：全局序号会让新增一条 world-read
  // 把后面所有 ask 的编号整体挪位，续跑就认不出原来的 ask、把它们重跑一遍。
  const before = sitesOf(`
const a = agent('x');
await a.ask('一');
await a.ask('二');
`);
  const after = sitesOf(`
await files.read('README.md');
const a = agent('x');
await a.ask('一');
await a.ask('二');
`);
  const asksBefore = before.sites.filter((site) => site.kind === 'ask').map((site) => site.id);
  const asksAfter = after.sites.filter((site) => site.kind === 'ask').map((site) => site.id);
  assert.deepEqual(asksAfter, asksBefore, 'ask 的编号不应因为前面多了一条读取而改变');
});

test('同类站点插在前面仍会挪位（已知代价，写清楚）', () => {
  // 不是疏漏，是"按顺序计数"的固有性质。真要完全稳定需要内容寻址，
  // 而内容会随编辑变化，那是另一种不稳定。写出来免得后人以为是缺陷。
  const before = sitesOf(`const a = agent('x');\nawait a.ask('一');\n`);
  const after = sitesOf(`const a = agent('x');\nawait a.ask('零');\nawait a.ask('一');\n`);
  assert.deepEqual(before.sites.filter((site) => site.kind === 'ask').map((site) => site.id), ['ask#1']);
  assert.deepEqual(after.sites.filter((site) => site.kind === 'ask').map((site) => site.id), ['ask#1', 'ask#2']);
});

test('别名接收者也要被认出来', () => {
  // 只看语法文本会漏掉别名，漏掉的后果是那条命令不进 journal、续跑时**重跑**。
  const table = sitesOf(`
const w = world;
await w.run('git', ['status']);
`);
  assert.deepEqual(table.sites.map((site) => site.id), ['world-run#1']);
});

test('站点带脚本原文的1-based行列', () => {
  const table = sitesOf(`\nawait world.run('git', ['status']);\n`);
  const site = table.sites[0];
  assert.ok(site);
  assert.equal(site.line, 2, '作者原文第二行');
  assert.equal(site.column, 7, '指向 world 的位置');
});

test('标签取字面量参数', () => {
  const table = sitesOf(`
const researcher = agent('研究员');
await researcher.ask('找出所有 TODO');
await files.grep('TODO', '*.ts');
await world.run('git', ['status']);
`);
  assert.deepEqual(table.sites.map((site) => site.label), ['研究员', '找出所有 TODO', 'grep(TODO)', 'git']);
});

test('未命名agent有可读标签', () => {
  const table = sitesOf(`const a = agent();\n`);
  assert.equal(table.sites[0]?.label, '（未命名）');
});

test('非字面量命令报稳定码', () => {
  // 命令要在确认时展示给用户。允许算出来的命令 = 允许"用户确认的"与"实际跑的"
  // 不是同一件事 —— 那会让确认这道闸门形同虚设。
  const table = sitesOf(`
const cmd = 'git';
await world.run(cmd, ['status']);
`);
  assert.equal(table.diagnostics.length, 1);
  assert.equal(table.diagnostics[0]?.code, NON_LITERAL_COMMAND_CODE);
  assert.equal(table.diagnostics[0]?.line, 3);
});

test('非字面量命令仍然进站点表', () => {
  // 报错不等于"不算数"：它确实会在运行时执行，所以必须出现在站点表里，
  // 否则上限统计与 journal 都会漏掉它。
  const table = sitesOf(`await world.run(someVariable);\n`);
  assert.deepEqual(table.sites.map((site) => site.id), ['world-run#1']);
});

test('log不是效应站点', () => {
  const table = sitesOf(`log('hello');\n`);
  assert.deepEqual(table.sites, []);
});

test('嵌套函数里的站点也会被收集', () => {
  // 只看顶层语句会漏掉写在函数体里的效应，而那些同样会执行。
  const table = sitesOf(`
async function 处理(name: string) {
  return await agent(name).ask('干活');
}
await 处理('甲');
`);
  assert.deepEqual(table.sites.map((site) => site.kind), ['actor', 'ask']);
});

test('循环里的站点只算一个站点', () => {
  // 静态只有一处调用点，所以只有一个身份；它执行多次是**运行期**的事实，
  // 由 journal 的"第几次"承担，不是站点表的事。
  const table = sitesOf(`
for (const name of ['甲', '乙']) {
  await agent(name).ask('干活');
}
`);
  assert.deepEqual(table.sites.map((site) => site.id), ['actor#1', 'ask#1']);
});

test('空脚本没有站点', () => {
  assert.deepEqual(sitesOf(''), { sites: [], diagnostics: [] });
});

test('promise.all里的站点按源码顺序收集', () => {
  const table = sitesOf(`
const a = agent('a');
const b = agent('b');
await Promise.all([a.ask('一'), b.ask('二')]);
`);
  assert.deepEqual(table.sites.map((site) => site.id), ['actor#1', 'actor#2', 'ask#1', 'ask#2']);
});

// ---------------------------------------------------------------------------
// 别名与解构：**这些写法以前会整体漏掉站点**。
//
// 漏掉的后果与"没写这条命令"看起来一样，但实际完全不同：命令照跑，
// 却不在确认清单里、不进 journal（续跑会**重跑**）、也不计入额度。
// 只在真跑一次副作用时才会发现 —— 而那时已经晚了。
// ---------------------------------------------------------------------------

test('方法解构后调用仍被识别', () => {
  const table = sitesOf(`
const { run } = world;
await run('git', ['status']);
`);
  assert.deepEqual(table.sites.map((site) => `${site.id}:${site.label}`), ['world-run#1:git']);
});

test('方法赋值后改名调用仍被识别', () => {
  // 成员名取**声明上的名字**，不是调用处的文本：这里调用处叫 r2，但它是 world.run。
  const table = sitesOf(`
const r2 = world.run;
await r2('git', ['status']);
`);
  assert.deepEqual(table.sites.map((site) => site.id), ['world-run#1']);
});

test('files的方法解构后仍被识别为读工作区', () => {
  const table = sitesOf(`
const { read } = files;
await read('a.md');
`);
  assert.deepEqual(table.sites.map((site) => `${site.id}:${site.kind}`), ['world-read#1:world-read']);
});

test('ask解构后仍被识别为派活', () => {
  const table = sitesOf(`
const a = agent('x');
const { ask } = a;
await ask('干活');
`);
  assert.deepEqual(table.sites.map((site) => site.kind), ['actor', 'ask']);
});

test('方括号访问也被识别', () => {
  const table = sitesOf(`
await world['run']('git', ['status']);
`);
  assert.deepEqual(table.sites.map((site) => site.id), ['world-run#1']);
});

test('脚本自己定义的函数不会被误判成效应站点', () => {
  // 反过来漏判（把普通函数当成效应）同样有害：确认清单会充满噪音，用户就不再细看。
  const table = sitesOf(`
function helper(value: string) { return value; }
helper('a');
const world2 = { run: (cmd: string) => cmd };
world2.run('git');
`);
  assert.deepEqual(table.sites, []);
});

test('解构出来的命令仍需是字面量', () => {
  // 换一种写法不该绕过"命令必须是字面量"这条规则。
  const table = sitesOf(`
const { run } = world;
await run(someCommand);
`);
  assert.equal(table.diagnostics.length, 1);
  assert.equal(table.diagnostics[0]?.code, NON_LITERAL_COMMAND_CODE);
});
