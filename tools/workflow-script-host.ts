// 工作流脚本 CLI 的**宿主适配层**：把 workflow-script 需要的执行端口接到真实的
// 本地 IO 上 —— spawn 进程、读工作区文件、把 journal 落盘、把 ask 转成"问用户"。
//
// ## 为什么在 tools/ 而不是 packages/workflow-script/
//
// workflow-script 是**纯包**（架构策略里 `requires: []`），保持纯粹才能被完整单测：
// 一旦它开始做 IO，"续跑不重跑"就没法用纯函数钉住了。所以执行端口由**调用方注入**，
// 这个文件就是那个调用方。`tools/` 下的东西本来就有 IO（见 plugin-marketplace-cli）。
//
// ## 这个宿主能做什么、不能做什么
//
// 能做：跑命令、读工作区文件、journal 落盘续跑。
//
// **子代理是降级的**：`agent('x').ask(...)` 与顶层 `ask` 共用同一个 `ask` 端口，
// 这里把它实现成**问用户**。这是诚实的 —— 脚本要一个决定，运行脚本的人来给。
// 但它**不是**子代理：没有独立上下文、没有模型、不能并行。所以本宿主只适合跑
// "命令 + 人工确认"型的脚本，不适合跑"起五个研究员并行调研"那种。
// 后者需要应用内的子代理能力（见 docs/design/workbench-node-capability-decision.md §3.1）。
//
// `files.glob` / `files.grep` **明确报错**，不返回空：返回空会让脚本以为
// "没有匹配的文件"，那是静默的错误，比报错危险。
//
// ## 安全边界
//
// - `world.run` 的 cwd 限定在 `--workdir`（默认 process.cwd()），不解析 shell。
// - 命令参数以 argv 数组传，**不经 shell** —— 脚本里写 `world.run('rm', ['-rf', '/'])`
//   就是字面执行，不做任何解释。这是 spawn 的默认行为，也是这里唯一的安全保证。
// - 没有超时：CLI 是作者工具，长任务该能跑完。要限时的调用方应自己注入 runtime。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { basename } from 'node:path';

import { parseJournal, type WorkflowJournalStore, type WorkflowRuntime } from '../packages/workflow-script/src/runner.js';
import type { WorkflowJournal } from '../packages/workflow-script/src/journal.js';
import type { WorkflowScriptCliExecution } from '../packages/workflow-script/src/cli.js';

/**
 * 从一个流里读**一行**（到 `\n` 为止，去掉行尾换行）。
 *
 * 不用 `node:readline`：这个仓库的 `@types/node` 把 `createInterface` 的签名
 * 声明成 web 的 `ReadableStream`，与 node 的 `Readable` 不兼容（TS2769）。
 * 运行时两者都能用，但类型上过不去。自己读缓冲区更直白，也没有额外依赖。
 *
 * EOF 时返回已读到的部分（可能为空串）。
 */
async function readLine(source: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline !== -1) {
        buffer += text.slice(0, newline);
        cleanup();
        resolve(buffer);
        return;
      }
      buffer += text;
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('error', onError);
    };
    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onError);
  });
}

/** 宿主的 IO 偏好。 */
export interface WorkflowScriptHostOptions {
  /** `world.run` 的工作目录；默认进程 cwd。 */
  readonly workdir?: string;
  /** 环境变量；默认继承当前进程。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `ask` 的输入/输出流；默认 stdin/stdout（测试可注入）。 */
  readonly input?: Readable;
  readonly output?: Writable;
  /** 是否在执行前打印将要跑的命令。默认 true —— 这是安全审计的可见性。 */
  readonly announce?: boolean;
}

/**
 * 造一个默认执行端口。
 *
 * 所有 IO 都在这里发生；workflow-script 仍然只拿到接口。
 */
export function createWorkflowScriptHost(
  options: WorkflowScriptHostOptions = {},
): WorkflowScriptCliExecution {
  const workdir = options.workdir ?? process.cwd();
  const announce = options.announce ?? true;

  const runtime: WorkflowRuntime = {
    log: (message) => {
      process.stdout.write(`[log] ${message}\n`);
    },
    run: (command, args) => {
      if (announce) {
        // 把整条命令打出来：脚本要跑什么，跑之前必须看得见。
        process.stdout.write(`[run] ${command} ${args.join(' ')}\n`);
      }
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: workdir,
          env: options.env ?? process.env,
          shell: false,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (error) => reject(error));
        child.on('close', (code) => {
          resolve({ exitCode: code ?? 0, stdout, stderr });
        });
      });
    },
    glob: async (pattern) => {
      // CLI 宿主只做**字面路径**：`files.glob` 在 facade 里接受的是 glob，
      // 但 CLI 没有 glob 库依赖，且工作流脚本里它绝大多数时候就是读一个文件。
      // 明确报错而不是返回空 —— 返回空会让脚本以为"文件不存在"。
      throw new Error(`files.glob 在 CLI 宿主里不支持（pattern=${pattern}）；请改用 files.read`);
    },
    read: async (path) => readFileSync(path, 'utf8'),
    grep: async (pattern) => {
      throw new Error(`files.grep 在 CLI 宿主里不支持（pattern=${pattern}）；请改用 files.read`);
    },
    ask: async (instructions) => {
      // CLI 没有子代理。ask 转成"问用户"是诚实的降级：脚本要一个决定，
      // 那就由运行脚本的人来给。返回 null 表示用户跳过了（直接回车）。
      const output = options.output ?? process.stdout;
      output.write(`[ask] ${instructions}\n> `);
      const line = await readLine(options.input ?? process.stdin);
      return line.trim() === '' ? null : line;
    },
  };

  return { runtime };
}

/**
 * 造一个 journal 端口，把 journal 落在一个 JSON 文件里。
 *
 * 路径的**目录**由 `--journal` 决定；不给路径时 CLI 用时间戳当 runId，
 * 此时调用方应当也跳过这个端口（没有可落盘的位置）。
 */
export function createFileJournalStore(path: string): WorkflowJournalStore {
  return {
    load: () => {
      if (!existsSync(path)) return undefined;
      try {
        return parseJournal(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        // 文件坏了不该让整轮跑挂掉：当作没有历史。但这会**重做**已做过的效应，
        // 所以必须让用户看见 —— 静默降级是最危险的那种。
        process.stderr.write(`[journal] ${path} 读不出来，按空历史处理（可能重做已做过的效应）\n`);
        return undefined;
      }
    },
    save: (journal: WorkflowJournal) => {
      writeFileSync(path, JSON.stringify(journal, null, 2));
    },
  };
}

/** 从 `--journal` 路径推出落盘位置；不给就返回 undefined（本轮不落盘）。 */
export function journalStoreFromPath(path: string | undefined): WorkflowJournalStore | undefined {
  return path ? createFileJournalStore(path) : undefined;
}

/** 便于日志定位的短名。 */
export function describeJournalPath(path: string | undefined): string {
  return path ?? '(未指定，本轮不落盘)';
}

/** 便于测试断言。 */
export function fileNameOf(path: string): string {
  return basename(path);
}
