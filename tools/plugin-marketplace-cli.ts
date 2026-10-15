// 一个文件=一种作用：插件市场 CLI 的极薄 shim —— 只把真实 argv / stdout / stderr 接到
// 可单测的 runPluginMarketplaceCli，并装配默认（SQLite）依赖。
//
// 运行（与仓库测试的 tsx 用法一致，需 --experimental-sqlite）：
//   node --experimental-sqlite --import tsx tools/plugin-marketplace-cli.ts add <source> --json
//   node --experimental-sqlite --import tsx tools/plugin-marketplace-cli.ts list --json
// 数据目录：AWO_PLUGIN_MARKETPLACE_HOME（默认 ~/.awo/plugin-marketplace）。

import {
  createDefaultPluginMarketplaceCliDependencies,
  runPluginMarketplaceCli,
} from '../packages/agent-runtime/src/plugin-marketplace-cli.js';

const dependencies = createDefaultPluginMarketplaceCliDependencies();
try {
  process.exitCode = await runPluginMarketplaceCli(
    process.argv.slice(2),
    {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
    dependencies,
  );
} finally {
  dependencies.close();
}
