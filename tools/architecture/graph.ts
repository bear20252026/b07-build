/**
 * 依赖图生成器：把策略模块与真实 import 边渲染成 Mermaid 依赖图。
 *
 * 产物 `dependency-graph.mmd` 是**生成物**，请勿手工编辑：
 *   - `npm run architecture:graph`        重新生成；
 *   - `npm run architecture:graph:check`  校验产物是否与当前依赖一致（CI 可选）。
 *
 * 输出保持确定性：模块与边都排序、统一 LF 换行，因此换机器/换平台不会产生噪声 diff。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectModuleEdges, DEPENDENCY_GRAPH_FILENAME, renderDependencyGraph } from './policy.js';

export function generateGraph(cwd: string = process.cwd()): string {
  const { policy, edges } = collectModuleEdges(cwd);
  return renderDependencyGraph(policy, edges);
}

/** 生成或校验依赖图；返回进程退出码。 */
export function runGraphCli(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): number {
  const checkOnly = argv.includes('--check');
  const generated = generateGraph(cwd);
  const filename = join(cwd, DEPENDENCY_GRAPH_FILENAME);

  if (checkOnly) {
    if (!existsSync(filename)) {
      console.error(`依赖图缺失：${DEPENDENCY_GRAPH_FILENAME}（运行 npm run architecture:graph 生成）`);
      return 1;
    }
    const current = readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
    if (current !== generated) {
      console.error(`依赖图已过期：${DEPENDENCY_GRAPH_FILENAME} 与当前依赖不一致（运行 npm run architecture:graph 重新生成）`);
      return 1;
    }
    console.log(`dependency graph up to date: ${DEPENDENCY_GRAPH_FILENAME}`);
    return 0;
  }

  writeFileSync(filename, generated);
  console.log(`dependency graph written: ${DEPENDENCY_GRAPH_FILENAME}`);
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const entryPath = resolve(entry);
  const modulePath = resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32'
    ? entryPath.toLowerCase() === modulePath.toLowerCase()
    : entryPath === modulePath;
}

if (isDirectRun()) {
  process.exitCode = runGraphCli();
}
