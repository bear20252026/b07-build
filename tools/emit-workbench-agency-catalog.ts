// 把预置角色目录导出成应用可读的 JSON。
//
// ## 为什么要有这一步
//
// 角色目录的数据（id / 分部 / 名称 / 描述 / 正文 / 内容摘要）由
// `@awo/knowledge-workflow` 的 `AgencyRoleCatalog` 派生，而那个包依赖 `node:crypto`
// 与 `node:fs` —— 渲染进程用不了。
//
// 于是把**派生结果**在构建期导出成 JSON，让应用只读数据、不读实现。
// 这样：
// - 应用不需要依赖那个 Node 包（也不需要放宽架构策略）；
// - 派生逻辑只有一份（这里调的就是那个类，不是抄一份规则）；
// - 角色正文更新时，重跑生成脚本即可，应用侧无需改动。
//
// ## 前置
//
// 必须先跑 `tools/generate-agency-role-catalog.mjs`（它把 .md 汇总成
// `agency-agents-builtins.generated.ts`）。本脚本读的是生成结果。
// 两个脚本由 `npm run agency:catalog` 串起来执行。
//
// 运行：node --import tsx tools/emit-workbench-agency-catalog.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AgencyRoleCatalog } from '../packages/knowledge-workflow/src/agency-role-catalog.js';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'apps/workbench/src/generated/agency-role-catalog.json');

const catalog = new AgencyRoleCatalog();
const roles = catalog.list().map((summary) => {
  const definition = catalog.get(summary.id);
  if (!definition) throw new Error(`目录自相矛盾：list() 有 ${summary.id} 但 get() 取不到`);
  return {
    id: definition.id,
    division: definition.division,
    displayName: definition.displayName,
    description: definition.description,
    source: definition.source,
    // 正文是**静态不可信内容**：它是被审查的上下文候选，不授予任何能力。
    content: definition.content,
    canAutoInject: definition.canAutoInject,
    canAuthorize: definition.canAuthorize,
    canGrantCapabilities: definition.canGrantCapabilities,
  };
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${JSON.stringify({
    // 版本随数据形状变；应用侧读取时会校验它。
    schemaVersion: 1,
    generatedFrom: 'packages/knowledge-workflow/src/third-party/agency-agents',
    license: 'MIT',
    copyright: 'Copyright (c) 2025 AgentLand Contributors',
    roles,
  }, null, 2)}\n`,
  'utf8',
);

process.stdout.write(`已导出 ${roles.length} 个预置角色 → ${output}\n`);
