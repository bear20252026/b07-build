// tools/architecture/test/graph.test.ts
// 一个文件=一种作用：依赖图产物的确定性与新鲜度验收测试。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { generateGraph } from '../graph.js';
import { DEPENDENCY_GRAPH_FILENAME, renderDependencyGraph, type ModuleEdge } from '../policy.js';
import { loadPolicy } from '../policy.js';

test('依赖图渲染是确定性的：同输入同输出', () => {
  const policy = loadPolicy();
  const edges: ModuleEdge[] = [
    { from: 'b', to: 'a' },
    { from: 'a', to: 'c' },
    { from: 'a', to: 'b' },
  ];
  const first = renderDependencyGraph(policy, edges);
  const second = renderDependencyGraph(policy, edges);
  assert.equal(first, second);
});

test('依赖图标注 managed 与 legacy，且不含自环', () => {
  const graph = generateGraph();
  assert.match(graph, /^graph LR$/m, '应是 Mermaid graph LR');
  assert.match(graph, /\(managed\)/);
  assert.match(graph, /\(legacy\)/);
  for (const line of graph.split('\n')) {
    const match = /^\s*(\S+) --> (\S+)$/.exec(line);
    if (match) assert.notEqual(match[1], match[2], `不应出现自环：${line}`);
  }
});

test('仓库内提交的依赖图与当前依赖一致（graph:check 的不变式）', () => {
  const committed = readFileSync(join(process.cwd(), DEPENDENCY_GRAPH_FILENAME), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  assert.equal(
    committed,
    generateGraph(),
    '依赖图已过期：请运行 npm run architecture:graph 重新生成',
  );
});
