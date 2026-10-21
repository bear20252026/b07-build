// 对着 facade 给工作流脚本做类型检查 —— 在**虚拟宿主**里。
//
// ## 为什么值得单独做一层
//
// 模型写的脚本是自由文本。若不检查就执行，最常见的失败不是"跑错"，而是**跑得通但什么
// 都没干**：写错一个名字（`world.run` 拼成 `world.exec`）、把 `agent` 当普通函数用。
// 这些在运行时表现为静默的空操作，而调用方会以为任务完成了。
//
// 对着 facade 做一次真类型检查，把这类错误挡在**执行之前**，且给出可读的定位。
// 这是 ZCode 那句 "the compiler that recovers rigor from those scripts" 的落点。
//
// ## 脚本被包进一个 async 函数（照搬 ZCode 的做法）
//
// 原文不直接作为顶层代码检查，而是拼成：
//
//     async function __workflowScript__() {
//     <作者的脚本>
//     }
//     export {};
//
// 三个后果，都是要的：
// - **顶层 await 合法**：脚本本来就是"派活 → 等结果"的时序代码，不让 await 就没法写；
// - **`return <值>` 合法**：脚本可以用 return 给出结果；
// - **文件仍是模块**（尾部的 `export {}`）：于是 `import` / `export` 出现在函数体里
//   会直接报错 —— facade 之外的世界连"引入"都做不到。
//
// 代价是位置要换算：wrapped 源码里的行列减掉前缀，才是作者原文的坐标。所有对外暴露的
// 位置都走 `toAuthorLocation`，**不做换算就等于给出错误的行号**，而错误行号比没有行号更糟。
//
// ## 与 ZCode 的差别
//
// ZCode 把 TS 标准库也**内嵌**进包里（它要能在打包后的 SEA 单文件里跑，那里没有
// node_modules）。b07 是常规 Node 运行，标准库从磁盘读即可，所以本模块用
// `ts.createCompilerHost` 而不是自造 lib 宿主 —— 少一份需要跟着 TS 版本同步的内嵌资产。
// 虚拟的只有两件事：facade 与脚本本身。

import * as ts from 'typescript';

import { WORKFLOW_FACADE_DTS, WORKFLOW_FACADE_FILE_NAME } from './facade.js';

/** 脚本在虚拟宿主里的文件名。站点收集按它判定"这段代码是不是作者的脚本"。 */
export const WORKFLOW_SCRIPT_FILE_NAME = 'workflow-script.ts';

/**
 * 包住脚本的 async 函数名。
 *
 * 站点收集要**定位这个声明**，用它把遍历限制在作者写的函数体里，并把顶层的 `return`
 * 与嵌套函数里的 `return` 区分开 —— 少了这条边界，脚本里任何一个内部函数的 return
 * 都会被误当成"运行的结果"。
 */
export const WORKFLOW_FUNCTION_NAME = '__workflowScript__';

/** 包装前缀。脚本原文从 wrapped 源码的第 2 行开始。 */
const SCRIPT_PRELUDE = `async function ${WORKFLOW_FUNCTION_NAME}() {\n`;
/** 包装后缀：闭合函数体，并用 `export {}` 把文件钉成模块。 */
const SCRIPT_EPILOGUE = '\n}\nexport {};\n';
/** 前缀占的行数（1-based 换算用）。 */
const PRELUDE_LINES = 1;

/** 一条诊断，位置已换算成**脚本原文**的 1-based 行列。 */
export interface WorkflowDiagnostic {
  /** TS 诊断码（2304 一类；直接用 TS 的码，便于查官方文档）。 */
  readonly code: number;
  /** 可读消息（语言取决于宿主 locale，这里不翻译）。 */
  readonly message: string;
  /** 1-based 行号，**脚本原文**坐标。 */
  readonly line: number;
  /** 1-based 列号，**脚本原文**坐标。 */
  readonly column: number;
}

/** 检查结果：程序本身 + 诊断 + 位置换算。 */
export interface WorkflowProgram {
  /** 类型检查后的 Program；站点收集要用它。 */
  readonly program: ts.Program;
  /** **wrapped** 源码的 SourceFile（位置是 wrapped 坐标，换算见 `toAuthorLocation`）。 */
  readonly sourceFile: ts.SourceFile;
  /** 脚本原文（作者坐标以它为准）。 */
  readonly source: string;
  /** 只含**脚本自身**的诊断（facade 是我们写的，不该产生噪音）。 */
  readonly diagnostics: readonly WorkflowDiagnostic[];
}

/**
 * 脚本能用的编译选项。
 *
 * `types: []` 是刻意的：不拉 `@types/*`，于是脚本里 `process`、`require`、`Buffer`
 * 全是 TS2304 —— **facade 之外的世界在编译期就不存在**。
 * 少了它，模型可以绕过 facade 直接摸 Node 全局，而站点收集看不到那些效应。
 *
 * `noUnusedLocals` 也**不**开：脚本里留一个没用上的中间变量是无害的，
 * 为它报错只会让模型把回合浪费在删变量上。
 */
function scriptCompilerOptions(): ts.CompilerOptions {
  return {
    strict: true,
    noEmit: true,
    allowJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    types: [],
    skipLibCheck: true,
  };
}

/** 造一个只虚拟 facade 与脚本的宿主；其余（标准库）走磁盘。 */
function createVirtualHost(wrapped: string): ts.CompilerHost {
  const options = scriptCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const fallback = {
    getSourceFile: host.getSourceFile.bind(host),
    fileExists: host.fileExists.bind(host),
    readFile: host.readFile.bind(host),
  };
  const virtual = new Map<string, string>([
    [WORKFLOW_FACADE_FILE_NAME, WORKFLOW_FACADE_DTS],
    [WORKFLOW_SCRIPT_FILE_NAME, wrapped],
  ]);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtual.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return fallback.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => virtual.has(fileName) || fallback.fileExists(fileName);
  host.readFile = (fileName) => virtual.get(fileName) ?? fallback.readFile(fileName);
  return host;
}

/**
 * 把 wrapped 源码里的位置换算成**脚本原文**坐标。
 *
 * 减掉前缀占的那一行。wrapped 第 1 行是前缀本身，没有对应原文，故夹到 1。
 */
export function toAuthorLocation(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
  const wrapped = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: Math.max(1, wrapped.line + 1 - PRELUDE_LINES), column: wrapped.character + 1 };
}

/** 把一条 TS 诊断换算成脚本原文坐标。 */
function toScriptDiagnostic(sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): WorkflowDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.start === undefined) {
    // 无位置的诊断（全局配置一类）落到 1:1，而不是丢弃 —— 丢弃会让"有错但没提示"。
    return { code: diagnostic.code, message, line: 1, column: 1 };
  }
  const location = toAuthorLocation(sourceFile, diagnostic.start);
  return { code: diagnostic.code, message, line: location.line, column: location.column };
}

/**
 * 建程序并做类型检查。
 *
 * **不抛异常**：脚本写错是常态，返回值里带诊断。只有"连脚本 SourceFile 都拿不到"
 * 才是宿主实现的问题，那时如实抛。
 */
export function createWorkflowProgram(source: string): WorkflowProgram {
  const wrapped = `${SCRIPT_PRELUDE}${source}${SCRIPT_EPILOGUE}`;
  const options = scriptCompilerOptions();
  const host = createVirtualHost(wrapped);
  const program = ts.createProgram(
    [WORKFLOW_FACADE_FILE_NAME, WORKFLOW_SCRIPT_FILE_NAME],
    options,
    host,
  );
  const sourceFile = program.getSourceFile(WORKFLOW_SCRIPT_FILE_NAME);
  if (!sourceFile) throw new Error('虚拟宿主没有返回脚本 SourceFile');
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === WORKFLOW_SCRIPT_FILE_NAME)
    .map((diagnostic) => toScriptDiagnostic(sourceFile, diagnostic));
  return { program, sourceFile, source, diagnostics };
}

/**
 * facade 自身是否干净。
 *
 * 单独导出来是为了**能测**：facade 有语法或语义错误时，所有脚本都会得到一堆
 * 指向 facade 的诊断，而调用方只看到"脚本有问题"。这条断言把责任分清楚。
 */
export function facadeDiagnostics(): readonly WorkflowDiagnostic[] {
  const program = createWorkflowProgram('').program;
  const facade = program.getSourceFile(WORKFLOW_FACADE_FILE_NAME);
  if (!facade) return [{ code: 0, message: 'facade 未进入程序', line: 1, column: 1 }];
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === WORKFLOW_FACADE_FILE_NAME)
    .map((diagnostic) => toScriptDiagnostic(facade, diagnostic));
}
