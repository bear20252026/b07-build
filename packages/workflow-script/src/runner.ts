// runner：把校验过的脚本**真的跑一遍**，并在每个效应前查 journal。
//
// ## 为什么与校验器分开放
//
// `cli.ts` 的 `check`/`effects` 只做静态判定，一个字节都不执行。执行是另一件事：
// 它要 spawn 进程、读文件、把结果写回 journal。混在一起会让"校验"这种可以在
// CI 里无副作用跑的能力，被绑上一堆运行时依赖。所以这里只负责**编排执行**，
// 具体动作全部由调用方注入（见 `WorkflowRuntime`）。
//
// ## 站点身份在执行时怎么落定
//
// 静态站点表把源码里的第 N 个同类站点叫 `${kind}#${N}`。执行前，`rewriteEffectCalls`
// 把每个效应调用改写成 `__site("<siteId>", () => <原调用>)` —— **siteId 在编译期
// 就绑死到源码站点上**，不靠运行时计数。
//
// 为什么不用运行时计数：循环里的同一个源码站点会被执行多次，按调用计数会把它
// 叫成 `#2`、`#3`，而站点表里只有一个 `#1`。绑定到源码位置后，同一站点的多次
// 执行共享同一个 siteId，attempt 由 runner 递增 —— 这正是 journal 键需要的形式
// （见 `sites.ts` 的 `rewriteEffectCalls` 注释）。
//
// ## 三条不可让的规矩
//
// 1. **先查 journal 再执行**。查到了就复用结果，一次都不重跑。
// 2. **上限在执行前判**。静态站点数超额时根本不该开始（`checkCaps` 已经判过，
//    运行中每次效应前再判一次剩余额度）。
// 3. **结果只追加**。`appendRecord` 拒绝同键重复； runner 把它当成**错误**上报，
//    而不是默默覆盖 —— 那意味着同一次效应被记了两遍。
//
// ## 不在这里做的事
//
// - 不落盘。journal 的读写由调用方注入（`loadJournal` / `saveJournal`）。
// - 不提供默认的 `ask` 实现。派活需要模型与子代理运行时，那是另一层的事；
//   默认实现**拒绝并说明原因**，而不是伪造一个"成功"的空回复。

import * as ts from 'typescript';

import { WORKFLOW_FUNCTION_NAME } from './compile.js';
import { WORKFLOW_FACADE_FILE_NAME, WORKFLOW_FACADE_DTS } from './facade.js';
import {
  appendRecord,
  checkCaps,
  emptyJournal,
  isValidJournalRecord,
  recordedResult,
  remainingEffects,
  type WorkflowJournal,
  type WorkflowRunCaps,
} from './journal.js';
import { collectSites, rewriteEffectCalls, SITE_DISPATCH_FUNCTION_NAME, type WorkflowSite } from './sites.js';
import type { WorkflowProgram } from './compile.js';

// ---------------------------------------------------------------------------
// 运行时端口
// ---------------------------------------------------------------------------

/** 一次 world.run 的结果（与 facade 的 `WorldRunResult` 同形）。 */
export interface RunnerWorldRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 一次 ask 的结果。 */
export type RunnerAskResult = unknown;

/** files.grep 命中的一行（与 facade 的 `GrepMatch` 同形）。 */
export interface RunnerGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * facade 的运行时实现。
 *
 * 全部方法都是**注入**的：runner 不假设作者环境里有什么。`ask` 由调用方决定
 * （接模型、或拒绝）。
 */
export interface WorkflowRuntime {
  /** `log(message)`：把进度写出去。 */
  readonly log: (message: string) => void;
  /** `world.run(cmd, args, opts)`：spawn 一个进程；非零退出**不算失败**。 */
  readonly run: (cmd: string, args: readonly string[], opts?: { readonly timeoutMs?: number }) => Promise<RunnerWorldRunResult>;
  /** `files.glob(pattern)`：列工作区相对路径。 */
  readonly glob: (pattern: string) => Promise<readonly string[]>;
  /** `files.read(path)`：读工作区文件为 UTF-8。 */
  readonly read: (path: string) => Promise<string>;
  /** `files.grep(pattern, glob?)`：搜内容。 */
  readonly grep: (pattern: string, glob?: string) => Promise<readonly RunnerGrepMatch[]>;
  /**
   * `Agent.ask(instructions)`。
   *
   * 返回值会原样成为脚本里 `await agent.ask(...)` 的答案，所以类型由脚本的
   * 类型参数决定。实现方需要自己处理模型调用与失败。
   */
  readonly ask: (instructions: string) => Promise<RunnerAskResult>;
}

/** journal 的持久化端口。 */
export interface WorkflowJournalStore {
  /** 读上一次运行的 journal；没有则返回 `undefined`。 */
  readonly load: () => WorkflowJournal | undefined;
  /** 把这一轮的 journal 写下去。**只在本轮有新增时调用**。 */
  readonly save: (journal: WorkflowJournal) => void;
}

// ---------------------------------------------------------------------------
// 执行结果
// ---------------------------------------------------------------------------

/** 一条站点的执行记录（给用户看的摘要）。 */
export interface RunnerSiteOutcome {
  readonly site: WorkflowSite;
  /** 这次是第几次执行（attempt）。 */
  readonly attempt: number;
  /** 是复用记录还是真的跑了。 */
  readonly reused: boolean;
}

/** 执行诊断。 */
export interface RunnerDiagnostic {
  readonly code: string;
  readonly message: string;
  /** 相关站点（如果有）。 */
  readonly siteId?: string;
}

/** 执行结果。 */
export interface WorkflowRunOutcome {
  /** 脚本是否跑完（含"全部复用"的情况）。 */
  readonly completed: boolean;
  /** 逐站点的执行情况，按执行顺序。 */
  readonly outcomes: readonly RunnerSiteOutcome[];
  readonly diagnostics: readonly RunnerDiagnostic[];
  /** 这一轮结束后的 journal（已含新增记录）。 */
  readonly journal: WorkflowJournal;
  /** 脚本 `return` 的值（如果有）。 */
  readonly returned: unknown;
}

// ---------------------------------------------------------------------------
// 编译脚本
// ---------------------------------------------------------------------------

/**
 * 把脚本文本编译成可执行的 JS。
 *
 * 用 `transpileModule` 而不是 `new Function` 直接跑 TS：前者做**完整的 TS→JS**
 * （去类型、转语法），后者只能跑已经是 JS 的文本。脚本里可能有 `const x: string = ...`
 * 这类注解，直接 `new Function` 会语法错。
 *
 * 不做类型检查：那是 `check` 子命令的事，runner 假定调用方已经校验过。
 * 不校验就执行会放过拼错的名字（`world.exec` 会变成运行时 `TypeError`），
 * 而 `prepareWorkflowRun` 的存在意义正是把这类错误挡在执行前。
 */
export function transpileWorkflowScript(source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    fileName: 'workflow-script.ts',
  });
  return result.outputText;
}

/** 把效应调用按站点身份改写，再转成 JS。 */
function compileForExecution(source: string, program: WorkflowProgram): string {
  return transpileWorkflowScript(rewriteEffectCalls(source, program));
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 跑一次脚本。
 *
 * `journal` 传**上一轮的**记录（续跑）；不传按空 journal 算。
 * `caps` 不传用默认额度。
 *
 * **不抛异常**（除非宿主实现有问题）：脚本执行中的失败被记成 diagnostic，
 * 返回值里体现。调用方据此决定要不要把 journal 落盘。
 */
export async function runWorkflowScript(
  source: string,
  options: {
    readonly runtime: WorkflowRuntime;
    readonly journal?: WorkflowJournal;
    readonly caps?: WorkflowRunCaps;
    readonly args?: Readonly<Record<string, unknown>>;
    readonly journalStore?: WorkflowJournalStore;
    readonly runId?: string;
  },
): Promise<WorkflowRunOutcome> {
  const caps = options.caps ?? { maxEffects: 1000 };
  const runId = options.runId ?? `run-${Date.now()}`;
  // 入参的 journal **不可变**（它是上一轮的记录，是续跑判断的依据）。
  // 本轮的追加累到 `current` 上 —— `appendRecord` 是纯函数，不接收返回值
  // 就等于没记，而“没记”会让续跑把做过的效应**重做一遍**。
  const previous = options.journal ?? emptyJournal(runId);
  let current = previous;
  const diagnostics: RunnerDiagnostic[] = [];
  const outcomes: RunnerSiteOutcome[] = [];

  // 先做静态判定：类型不干净、站点收集不干净、额度不够 —— 一件过不了就不该开始。
  const program = await import('./compile.js').then((m) => m.createWorkflowProgram(source));
  if (program.diagnostics.length > 0) {
    return {
      completed: false,
      outcomes,
      diagnostics: program.diagnostics.map((d) => ({ code: String(d.code), message: d.message, siteId: undefined })),
      journal: previous,
      returned: undefined,
    };
  }
  const table = collectSites(program);
  const capDiagnostics = checkCaps(table.sites, previous, caps);
  if (table.diagnostics.length > 0 || capDiagnostics.length > 0) {
    return {
      completed: false,
      outcomes,
      diagnostics: [
        ...table.diagnostics.map((d) => ({ code: d.code, message: d.message })),
        ...capDiagnostics.map((d) => ({ code: d.code, message: d.message })),
      ],
      journal: previous,
      returned: undefined,
    };
  }

  // 站点身份 → 尝试次数的计数器。**按 siteId** 递增，而不是按调用顺序编新号：
  // 同一个源码站点在循环里跑两次，两次都是 `world-run#1`，只是 attempt 不同。
  const attempts = new Map<string, number>();
  const nextAttempt = (siteId: string): number => {
    const next = (attempts.get(siteId) ?? 0) + 1;
    attempts.set(siteId, next);
    return next;
  };

  const siteById = (siteId: string): WorkflowSite => {
    const site = table.sites.find((candidate) => candidate.id === siteId);
    if (!site) throw new Error(`站点表里找不到 ${siteId}（改写漏了或改错了）`);
    return site;
  };

  /** 执行一个效应站点：先查 journal，再决定复用还是真的跑。 */
  const runSite = async (siteId: string, perform: () => Promise<unknown>): Promise<unknown> => {
    const attempt = nextAttempt(siteId);
    const lookup = recordedResult(current, siteId, attempt);
    if (lookup.kind === 'recorded') {
      outcomes.push({ site: siteById(siteId), attempt, reused: true });
      return lookup.result;
    }
    // 上限在**执行前**判：事后再数就晚了。
    if (remainingEffects(current, table.sites, caps) <= 0) {
      diagnostics.push({
        code: 'workflow-effect-budget-exhausted',
        message: `效应额度已用尽，站点 ${siteId} 的第 ${attempt} 次执行被拒绝。`,
        siteId,
      });
      throw new WorkflowRunAbort();
    }
    let result: unknown;
    try {
      result = await perform();
    } catch (error) {
      // 进程失败（spawn 失败、超时）是**执行层**的失败，不是脚本的失败：
      // 记成 diagnostic 让调用方知道，但不要把它混进 journal ——
      // 一次失败的效应不该留下"做过了"的记录，否则续跑会复用一个根本没发生的结果。
      diagnostics.push({
        code: 'workflow-effect-failed',
        message: `站点 ${siteId} 的第 ${attempt} 次执行失败：${error instanceof Error ? error.message : String(error)}`,
        siteId,
      });
      throw new WorkflowRunAbort();
    }
    // 只追加，不覆盖。`appendRecord` 的返回值必须接住，否则本轮的记录丢了。
    const appended = appendRecord(current, siteId, attempt, result);
    if (!appended.appended) {
      // 同键重复是**内部错误**：改写把两次执行绑到了同一个站点身份上。
      diagnostics.push({
        code: 'workflow-journal-collision',
        message: `站点 ${siteId} 的第 ${attempt} 次已经有过记录 —— 同键重复，拒绝覆盖。`,
        siteId,
      });
      throw new WorkflowRunAbort();
    }
    current = appended.journal;
    outcomes.push({ site: siteById(siteId), attempt, reused: false });
    return result;
  };

  // facade 的运行时实现。效应调用已经改写成 `__site(...)`，所以这里只需要提供
  // 那个派发函数：它才是所有效应的共同入口，journal 与额度都在它里面判。
  const runtimeFacade = buildRuntimeFacade(options.runtime, runSite);

  try {
    const returned = await executeTranspiled(
      compileForExecution(source, program),
      runtimeFacade,
      options.args ?? {},
    );
    // 只有**真的新增**了记录才落盘。全部复用时写一份一样的 journal 没有意义，
    // 还会掩盖“这一轮其实什么都没做”——而那是续跑时最想被看见的信息。
    if (current.records.length > previous.records.length) options.journalStore?.save(current);
    return { completed: true, outcomes, diagnostics, journal: current, returned };
  } catch (error) {
    if (error instanceof WorkflowRunAbort) {
      // 已经记过 diagnostic；journal 只保留已成功的部分（那是有意义的续跑基础）。
      if (current.records.length > previous.records.length) options.journalStore?.save(current);
      return { completed: false, outcomes, diagnostics, journal: current, returned: undefined };
    }
    throw error;
  }
}

/** 中止执行的内部信号。 */
class WorkflowRunAbort extends Error {
  constructor() {
    super('workflow run aborted');
    this.name = 'WorkflowRunAbort';
  }
}

/**
 * 造 facade 的运行时实现。
 *
 * 这里**不再给每个成员编号**：siteId 已经由 `rewriteEffectCalls` 烧进调用里了。
 * facade 成员只是把活转出去，唯一的"效应入口"是 `__site`。
 *
 * `actor` 也是**不占额度**的：它只创建一条对话，真正的活在 ask 上。所以它不进
 * `__site`，在 facade 里就是原样透传。
 */
function buildRuntimeFacade(
  runtime: WorkflowRuntime,
  runSite: (siteId: string, perform: () => Promise<unknown>) => Promise<unknown>,
): Readonly<Record<string, unknown>> {
  // 用函数声明而不是 const 箭头：函数声明会提升，因此下面 return 里的对象字面量
  // 可以直接引用它们（`const files` 在 return 之后声明会踩 TDZ）。
  return {
    agent: agentCreate,
    log: runtime.log,
    files: { glob: filesGlob, read: filesRead, grep: filesGrep },
    world: { run: worldRun },
    [SITE_DISPATCH_FUNCTION_NAME]: (siteId: string, perform: () => Promise<unknown>): Promise<unknown> =>
      runSite(siteId, perform),
  };

  function worldRun(
    cmd: string,
    args?: readonly string[],
    opts?: { readonly timeoutMs?: number },
  ): Promise<RunnerWorldRunResult> {
    return runtime.run(cmd, args ?? [], opts);
  }

  function filesGlob(pattern: string): Promise<readonly string[]> {
    return runtime.glob(pattern);
  }

  function filesRead(path: string): Promise<string> {
    return runtime.read(path);
  }

  function filesGrep(pattern: string, glob?: string): Promise<readonly RunnerGrepMatch[]> {
    return runtime.grep(pattern, glob);
  }

  function agentCreate(): { ask: (instructions: string) => Promise<RunnerAskResult> } {
    return {
      ask: (instructions: string): Promise<RunnerAskResult> =>
        runtime.ask(instructions) as Promise<RunnerAskResult>,
    };
  }
}

/**
 * 执行编译后的脚本。
 *
 * 用 `new Function` 把脚本包进一个 async 函数，参数是 facade 的五个全局名。
 * 这样脚本里的 `agent(...)`、`world.run(...)` 会解析到**注入的实现**，而不是
 * 全局对象上的什么东西 —— facade 之外的世界在运行时也不存在。
 */
async function executeTranspiled(
  javascript: string,
  facade: Readonly<Record<string, unknown>>,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  // `args` 与 `__site` 都作为**参数**传进去，而不是挂到 globalThis：脚本里它们是
  // 只读的，挂全局会让它们能被意外改写。
  const fn = new Function(
    'agent',
    'log',
    'files',
    'world',
    'args',
    SITE_DISPATCH_FUNCTION_NAME,
    `"use strict";\nreturn (async () => {\n${javascript}\n})();`,
  ) as (
    agent: unknown,
    log: unknown,
    files: unknown,
    world: unknown,
    args: Readonly<Record<string, unknown>>,
    site: unknown,
  ) => Promise<unknown>;
  return await fn(
    facade.agent,
    facade.log,
    facade.files,
    facade.world,
    args,
    facade[SITE_DISPATCH_FUNCTION_NAME],
  );
}

/** 校验从磁盘读回来的 journal（防止被手改坏后续跑）。 */
export function parseJournal(value: unknown): WorkflowJournal | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<WorkflowJournal>;
  if (candidate.schemaVersion !== 1) return undefined;
  if (typeof candidate.runId !== 'string') return undefined;
  if (!Array.isArray(candidate.records)) return undefined;
  if (!candidate.records.every((record) => isValidJournalRecord(record))) return undefined;
  return candidate as WorkflowJournal;
}

/** facade 文件名与内容（供驱动层校验脚本时复用）。 */
export { WORKFLOW_FACADE_DTS, WORKFLOW_FACADE_FILE_NAME };
export { WORKFLOW_FUNCTION_NAME };
