// 一个文件=一种作用：工作流脚本 CLI 的极薄 shim —— 只把真实 argv / stdout / stderr
// 与本地 IO 接到可单测的 runWorkflowScriptCli，并装配默认（本地执行）宿主。
//
// 运行：
//   node --import tsx tools/workflow-script-cli.ts check path/to/workflow.ts
//   node --import tsx tools/workflow-script-cli.ts effects path/to/workflow.ts --json
//   node --import tsx tools/workflow-script-cli.ts run path/to/workflow.ts --journal run.json
//   node --import tsx tools/workflow-script-cli.ts run path/to/workflow.ts --workdir ../repo
//
// `--workdir` 同时是 `world.run` 的 cwd 与 journal 的默认位置基准。
// 执行端口（spawn / 读文件 / 问用户）在 workflow-script-host.ts 里装配。

import { readFileSync } from 'node:fs';

import { runWorkflowScriptCli } from '../packages/workflow-script/src/cli.js';
import { createWorkflowScriptHost, journalStoreFromPath } from './workflow-script-host.js';

// `--workdir` 不在 runWorkflowScriptCli 的通用参数里：它是**宿主**的偏好，
// 不是校验器的。所以这里先把它从 argv 里摘出来，剩下的再交给校验器。
const argv = process.argv.slice(2);
const workdirIndex = argv.indexOf('--workdir');
let workdir: string | undefined;
if (workdirIndex !== -1) {
  workdir = argv[workdirIndex + 1];
  if (!workdir) {
    process.stderr.write('--workdir 需要一个路径。\n');
    process.exitCode = 2;
  } else {
    argv.splice(workdirIndex, 2);
  }
}

const journalPath = argv[argv.indexOf('--journal') + 1];

process.exitCode = await runWorkflowScriptCli(
  argv,
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  {
    readFile: (path) => readFileSync(path, 'utf8'),
  },
  {
    ...createWorkflowScriptHost({ workdir }),
    journalStore: journalStoreFromPath(journalPath),
  },
);
