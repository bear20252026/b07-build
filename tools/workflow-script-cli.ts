// 一个文件=一种作用：工作流脚本校验器的极薄 shim —— 只把真实 argv / stdout / stderr
// 与 `node:fs` 接到可单测的 runWorkflowScriptCli。
//
// 运行：
//   node --import tsx tools/workflow-script-cli.ts check path/to/workflow.ts
//   node --import tsx tools/workflow-script-cli.ts effects path/to/workflow.ts --json
//
// 只做校验与预览，不执行脚本 —— 执行需要一个能跑子代理与命令的驱动层，那还没接。

import { readFileSync } from 'node:fs';

import { runWorkflowScriptCli } from '../packages/workflow-script/src/cli.js';

process.exitCode = await runWorkflowScriptCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  {
    readFile: (path) => readFileSync(path, 'utf8'),
  },
);
