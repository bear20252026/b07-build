import assert from 'node:assert/strict';
import test from 'node:test';

import { WORKFLOW_FACADE_DTS } from '../src/facade.js';
import { createWorkflowProgram, facadeDiagnostics } from '../src/compile.js';

// ---------------------------------------------------------------------------
// 对着 facade 的类型检查：把"跑得通但什么都没干"挡在执行之前。
// ---------------------------------------------------------------------------

/** TS 表示"这个名字不可用"的两个码：找不到名称 / 认出是 Node 全局并建议装 @types/node。 */
const NAME_UNAVAILABLE_CODES = new Set([2304, 2591]);

test('facade 自身没有类型错误', () => {
  // facade 有错时，所有脚本都会得到一堆指向 facade 的诊断，
  // 而调用方只看到"脚本有问题"。这条把责任分清楚。
  assert.deepEqual(facadeDiagnostics(), []);
});

test('facade 声明了 b07 移植的全部可写面', () => {
  for (const name of ['agent', 'log', 'files', 'world', 'args', 'Agent', 'Node', 'WorldRunResult', 'GrepMatch']) {
    assert.ok(WORKFLOW_FACADE_DTS.includes(name), `facade 应声明 ${name}`);
  }
});

test('合法脚本没有诊断', () => {
  const program = createWorkflowProgram(`
const researcher = agent('研究员');
const answer = await researcher.ask<string>('列出所有 TODO');
log('结果：' + answer);
const paths = await files.glob('src/**/*.ts');
const text = await files.read(paths[0]);
const hits = await files.grep('TODO', '*.ts');
const run = await world.run('git', ['status']);
if (run.exitCode !== 0) log('git 退出码 ' + run.exitCode);
const target = String(args.target);
`);
  assert.deepEqual(program.diagnostics, []);
});

test('不带类型参数的ask返回文本', () => {
  const program = createWorkflowProgram(`
const a = agent('x');
const text: string = await a.ask('说点什么');
`);
  assert.deepEqual(program.diagnostics, []);
});

test('Node可以交给Promise.all', () => {
  // facade 的 Node<T> 是 PromiseLike；不满足它的话"并行派活"就写不出来，
  // 而并行正是用脚本编排（而不是工具链）的主要理由。
  const program = createWorkflowProgram(`
const a = agent('a');
const b = agent('b');
const [x, y] = await Promise.all([a.ask('甲'), b.ask('乙')]);
`);
  assert.deepEqual(program.diagnostics, []);
});

test('facade之外的世界在编译期不存在', () => {
  // 少了这条，模型可以绕过 facade 直接摸 Node 全局，而站点收集看不到那些效应。
  const program = createWorkflowProgram(`
const home = process.env.HOME;
const fs = require('node:fs');
`);
  assert.equal(program.diagnostics.length, 2, `两个越界引用都应被报出来：${JSON.stringify(program.diagnostics)}`);
  for (const diagnostic of program.diagnostics) {
    assert.ok(NAME_UNAVAILABLE_CODES.has(diagnostic.code), `实际码：${diagnostic.code}`);
  }
  const messages = program.diagnostics.map((diagnostic) => diagnostic.message).join(' / ');
  assert.match(messages, /process/);
  assert.match(messages, /require/);
});

test('脚本里不能import', () => {
  // 脚本被包进 async 函数体（尾部有 export {} 把文件钉成模块），
  // 于是"引入"在函数体里就是错误 —— facade 之外的世界连引入都做不到。
  const program = createWorkflowProgram("import { readFile } from 'node:fs/promises';");
  assert.ok(program.diagnostics.length > 0, 'import 应报错');
});

test('拼错facade成员会被抓到', () => {
  const program = createWorkflowProgram(`
world.exec('git', ['status']);
`);
  const messages = program.diagnostics.map((diagnostic) => diagnostic.message).join(' / ');
  assert.match(messages, /exec/);
});

test('诊断带脚本内的1-based行列', () => {
  // 脚本被包进 async 函数（前面多一行前缀），所以这条同时钉住了**位置换算**：
  // 不换算的话 `undefinedName` 会被报在第 3 行，而不是作者写的第 2 行。
  const program = createWorkflowProgram("log('ok');\nlog(undefinedName);\n");
  const diagnostic = program.diagnostics.find((item) => item.message.includes('undefinedName'));
  assert.ok(diagnostic, `应报找不到 undefinedName：${JSON.stringify(program.diagnostics)}`);
  assert.equal(diagnostic.line, 2, '作者原文的第二行');
  assert.equal(diagnostic.column, 5, '指向 log( 之后的标识符');
});

test('类型不匹配会被抓到', () => {
  const program = createWorkflowProgram(`
const a = agent('x');
const n: number = await a.ask<string>('文本');
`);
  assert.equal(program.diagnostics[0]?.code, 2322, 'string 赋给 number 应报 2322');
});

test('ask的类型参数是声明而不是校验', () => {
  // 这条钉住一个**已知行为**，而不是假装它不存在：`ask<T = string>` 是泛型调用，
  // 不写类型参数时 TS 会从**上下文**推断 T —— 于是下面这段没有任何诊断。
  //
  // 这不是缺陷：T 的用途是"声明答案该是什么形状"（运行时据此合成 schema 校验），
  // 不是"让 TS 替你挡住错标注"。写清楚它，免得后人以为类型检查漏了。
  const program = createWorkflowProgram(`
const a = agent('x');
const n: number = await a.ask('文本');
`);
  assert.deepEqual(program.diagnostics, []);
});

test('空脚本没有诊断', () => {
  assert.deepEqual(createWorkflowProgram('').diagnostics, []);
});

test('facade是纯文本资产不依赖磁盘', () => {
  // facade 以字符串随包发布（ZCode 的 FACADE_DTS 同款做法）：打包后没有
  // node_modules 时也能检查。这里钉住"它确实是个字符串常量"。
  assert.equal(typeof WORKFLOW_FACADE_DTS, 'string');
  assert.ok(WORKFLOW_FACADE_DTS.length > 1000);
});
