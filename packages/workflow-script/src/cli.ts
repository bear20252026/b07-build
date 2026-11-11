// 工作流脚本校验器的 CLI（可单测；不做任何 IO，读写全由调用方注入）。
//
// ## 为什么要有它
//
// 动态工作流脚本要跑起来，需要一个能跑子代理与命令的驱动层。**校验**不需要它
// （类型检查、站点枚举、额度判定全是纯逻辑），但**执行**需要：spawn 进程、
// 读工作区文件、把 journal 落盘。这些 IO 全部由调用方注入，本模块只做编排。
//
// 三个子命令，对应"批准一次运行"的完整闭环：
// - `check`：写完脚本立刻知道①哪里类型不对②会做哪些有副作用的事③会不会超额。
// - `effects`：只列"会做什么"，用于确认清单。
// - `run`：真的跑，带 journal 续跑与额度闸门。
//
// ## 为什么放在 Node 而不是渲染进程
//
// 类型检查要 `typescript`（约 8 MB）。把它打进 webview 的包里是不划算的：
// 渲染进程只为了一个偶尔打开的校验页就要加载一整个编译器。CLI 在 Node 里跑，
// 那里本来就有 `typescript`（devDependency），也不需要打包。
//
// ## 退出码
//
// 0 = 干净（或运行完成）；1 = 有诊断（脚本有问题或运行失败）；2 = 用法错误（参数不对、文件读不到）。
// 与常见 CLI 一致，便于挂在 CI 或 git hook 上。

import { describeEffects, prepareWorkflowRun } from './prepare.js';
import { runWorkflowScript, type WorkflowJournalStore, type WorkflowRuntime } from './runner.js';

/** 输出端口。注入而不是直接摸 `process`：本模块要能在测试里断言输出。 */
export interface WorkflowScriptCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** 依赖端口。只注入了"读文件"，因为这是唯一的 IO。 */
export interface WorkflowScriptCliDependencies {
  /** 读脚本源码；抛异常表示读不到（CLI 会转成退出码 2）。 */
  readonly readFile: (path: string) => string;
}

/**
 * `run` 子命令需要的执行端口。
 *
 * 与基础依赖分开：`check`/`effects` 一个字节都不执行，不该被迫提供一个
 * 能 spawn 进程的实现。缺执行端口时 `run` 报用法错误（退出码 2），
 * 而不是伪造一个"跑过了"的结果。
 */
export interface WorkflowScriptCliExecution {
  readonly runtime: WorkflowRuntime;
  readonly journalStore?: WorkflowJournalStore;
}

/** 退出码。 */
export const WORKFLOW_CLI_OK = 0;
export const WORKFLOW_CLI_DIAGNOSTICS = 1;
export const WORKFLOW_CLI_USAGE = 2;

const USAGE = [
  '用法：',
  '  workflow-script check <脚本路径> [--max-effects N] [--json]',
  '  workflow-script effects <脚本路径>',
  '  workflow-script run <脚本路径> [--journal <路径>] [--max-effects N] [--json]',
  '',
  '  check     类型检查 + 站点枚举 + 额度判定；有诊断时退出码 1',
  '  effects   只打印"这次运行会做哪些有副作用的事"',
  '  run       真的执行脚本；journal 存在时续跑（已做过的效应不重做）',
  '',
  '  --max-effects N  效应次数上限（默认 1000）',
  '  --journal <路径>  journal 的读写位置（run 专用；不给则本轮不落盘）',
  '  --json           机器可读输出',
].join('\n');

/** 解析出来的选项。 */
interface ParsedArguments {
  readonly command: 'check' | 'effects' | 'run';
  readonly path: string;
  readonly maxEffects: number;
  readonly journalPath?: string;
  readonly json: boolean;
}

/** 解析失败时返回错误文案（而不是抛异常：CLI 不该把栈甩给用户）。 */
function parseArguments(argv: readonly string[]): ParsedArguments | string {
  const positional: string[] = [];
  let maxEffects = 1000;
  let journalPath: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--max-effects') {
      const raw = argv[index + 1];
      index += 1;
      const parsed = Number(raw);
      // 额度必须是正整数：0 或负数会让"额度判定"永远拒绝，而 NaN 会让它永远通过。
      if (!Number.isSafeInteger(parsed) || parsed < 1) return `--max-effects 需要一个正整数，收到：${raw ?? '（缺失）'}`;
      maxEffects = parsed;
      continue;
    }
    if (argument === '--journal') {
      const raw = argv[index + 1];
      index += 1;
      if (!raw) return '--journal 需要一个路径。';
      journalPath = raw;
      continue;
    }
    if (argument.startsWith('-')) return `未知选项：${argument}`;
    positional.push(argument);
  }
  const [command, path, ...rest] = positional;
  if (command !== 'check' && command !== 'effects' && command !== 'run') {
    return `未知子命令：${command ?? '（缺失）'}`;
  }
  if (!path) return '缺少脚本路径。';
  if (rest.length > 0) return `多余的参数：${rest.join(' ')}`;
  return { command, path, maxEffects, journalPath, json };
}

/** 一条诊断的可读行。 */
function formatDiagnostic(diagnostic: { code: number | string; message: string; line: number; column: number }): string {
  return `  ${diagnostic.line}:${diagnostic.column}  [${diagnostic.code}] ${diagnostic.message}`;
}

/** 跑一次 CLI，返回退出码。 */
export async function runWorkflowScriptCli(
  argv: readonly string[],
  io: WorkflowScriptCliIo,
  dependencies: WorkflowScriptCliDependencies,
  execution?: WorkflowScriptCliExecution,
): Promise<number> {
  const parsed = parseArguments(argv);
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n\n${USAGE}\n`);
    return WORKFLOW_CLI_USAGE;
  }

  let source: string;
  try {
    source = dependencies.readFile(parsed.path);
  } catch (error: unknown) {
    io.stderr(`读不到脚本 ${parsed.path}：${error instanceof Error ? error.message : String(error)}\n`);
    return WORKFLOW_CLI_USAGE;
  }

  // `effects` 只关心站点：类型不干净时站点表可能是误导性的（拼错的名字会被当成
  // "不是效应"），所以仍然先检查，但只把诊断打到 stderr，不让它盖住清单。
  const prepared = prepareWorkflowRun(source, { caps: { maxEffects: parsed.maxEffects } });

  if (parsed.command === 'effects') {
    if (!prepared.ok) {
      // 类型不干净时 `prepare` 会**刻意不给站点表**：拼错的名字会被当成"不是效应"，
      // 于是清单看着完整、其实漏了东西。所以这里不能说"可能不完整"（那暗示有一份
      // 可以看的东西），而要说"给不出可靠清单"，并把诊断原样打出来。
      io.stderr('脚本有诊断，无法给出可靠的效应清单（修好诊断后再看）：\n');
      for (const diagnostic of prepared.diagnostics) io.stderr(`${formatDiagnostic(diagnostic)}\n`);
    }
    const effects = describeEffects(prepared.sites);
    if (parsed.json) {
      io.stdout(`${JSON.stringify({ ok: prepared.ok, effects }, null, 2)}\n`);
    } else if (effects.length === 0) {
      io.stdout('这次运行没有任何有副作用的操作。\n');
    } else {
      io.stdout(['这次运行会做：', ...effects.map((line) => `  - ${line}`)].join('\n') + '\n');
    }
    return prepared.ok ? WORKFLOW_CLI_OK : WORKFLOW_CLI_DIAGNOSTICS;
  }

  if (parsed.command === 'check') {
    if (parsed.json) {
      io.stdout(`${JSON.stringify({
        ok: prepared.ok,
        diagnostics: prepared.diagnostics,
        sites: prepared.sites,
        effects: describeEffects(prepared.sites),
      }, null, 2)}\n`);
      return prepared.ok ? WORKFLOW_CLI_OK : WORKFLOW_CLI_DIAGNOSTICS;
    }

    if (prepared.diagnostics.length > 0) {
      io.stdout(['脚本有诊断：', ...prepared.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic))].join('\n') + '\n');
    }
    const effects = describeEffects(prepared.sites);
    io.stdout([
      prepared.diagnostics.length === 0 ? '脚本检查通过。' : '',
      `效应站点 ${prepared.sites.filter((site) => site.kind !== 'actor').length} 个：`,
      ...(effects.length > 0 ? effects.map((line) => `  - ${line}`) : ['  （无）']),
      // 说明现状，避免用户以为它已经能跑。
      '注意：本工具只做校验与预览，不会执行脚本。',
    ].filter((line) => line !== '').join('\n') + '\n');
    return prepared.ok ? WORKFLOW_CLI_OK : WORKFLOW_CLI_DIAGNOSTICS;
  }

  // ---- run ----

  // 执行端口缺失时**明确报错**，而不是伪造一个"跑过了"的空结果：
  // 那会让用户以为效应真的发生了。
  if (!execution?.runtime) {
    io.stderr('run 需要执行端口（runtime），但调用方没有提供。\n');
    return WORKFLOW_CLI_USAGE;
  }

  // 静态判定不过就不该开始跑：类型错乱时站点表是误导性的，跑起来只会做出
  // 用户没批准过的效应。
  if (!prepared.ok) {
    io.stderr(['脚本有诊断，拒绝执行：', ...prepared.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic))].join('\n') + '\n');
    return WORKFLOW_CLI_DIAGNOSTICS;
  }

  const outcome = await runWorkflowScript(source, {
    runtime: execution.runtime,
    caps: { maxEffects: parsed.maxEffects },
    journalStore: execution.journalStore,
    runId: parsed.journalPath ?? `run-${Date.now()}`,
  });

  if (parsed.json) {
    io.stdout(`${JSON.stringify({
      completed: outcome.completed,
      diagnostics: outcome.diagnostics,
      outcomes: outcome.outcomes.map((entry) => ({
        siteId: entry.site.id,
        kind: entry.site.kind,
        line: entry.site.line,
        attempt: entry.attempt,
        reused: entry.reused,
      })),
      records: outcome.journal.records.length,
      appended: outcome.appended,
      returned: outcome.returned,
    }, null, 2)}\n`);
    return outcome.completed ? WORKFLOW_CLI_OK : WORKFLOW_CLI_DIAGNOSTICS;
  }

  if (outcome.diagnostics.length > 0) {
    io.stdout(['运行中有诊断：', ...outcome.diagnostics.map((d) => `  [${d.code}] ${d.message}`)].join('\n') + '\n');
  }
  const effects = describeEffects(prepared.sites);
  io.stdout([
    outcome.completed ? '运行完成。' : '运行未完成（见诊断）。',
    `效应站点 ${effects.length} 个：`,
    ...(effects.length > 0 ? effects.map((line) => `  - ${line}`) : ['  （无）']),
    `journal 记录 ${outcome.journal.records.length} 条，本轮新增 ${outcome.appended} 条。`,
  ].filter((line) => line !== '').join('\n') + '\n');
  return outcome.completed ? WORKFLOW_CLI_OK : WORKFLOW_CLI_DIAGNOSTICS;
}
