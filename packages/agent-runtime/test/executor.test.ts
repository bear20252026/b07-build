import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskEvent, type TaskEvent } from '@awo/protocol';
import { DAGExecutor, type DAGNode, type ToolRunner } from '../src/executor.js';

class SuccessfulRunner implements ToolRunner {
  async run(_node: DAGNode): Promise<{ ok: boolean; outputRef: string }> {
    return { ok: true, outputRef: 'artifact://parsed-document' };
  }
}

test('DAG 执行器发出的调用和结果事件都符合 v1.0 事件契约', async () => {
  const events: TaskEvent[] = [];
  const executor = new DAGExecutor(
    { taskId: 'task-1', runId: 'run-1', now: () => 100 },
    (event) => events.push(event),
    new SuccessfulRunner(),
  );

  await executor.run([
    {
      id: 'parse-1',
      kind: 'tool',
      tool: {
        name: 'document.parse',
        args: { path: '/local/brief.md' },
        capability: 'document.parse',
        risk: 'low',
      },
      idempotencyKey: 'brief-sha256',
      deps: [],
    },
  ]);

  assert.deepEqual(events.map((event) => event.type), ['tool.called', 'tool.result']);
  assert.ok(events.every(isTaskEvent));
  assert.equal(events[0]?.taskId, 'task-1');
  assert.equal(events[1]?.runId, 'run-1');
});

test('DAG 执行器在触达工具前拒绝存在依赖环的任务图', async () => {
  let calls = 0;
  const executor = new DAGExecutor(
    { taskId: 'task-cycle', runId: 'run-cycle' },
    () => undefined,
    {
      async run(): Promise<{ ok: boolean; outputRef: string }> {
        calls += 1;
        return { ok: true, outputRef: 'never' };
      },
    },
  );
  const tool = {
    name: 'document.parse',
    args: {},
    capability: 'document.parse' as const,
    risk: 'low' as const,
  };

  await assert.rejects(
    executor.run([
      { id: 'a', kind: 'tool', tool, deps: ['b'] },
      { id: 'b', kind: 'tool', tool, deps: ['a'] },
    ]),
    /cycle detected/,
  );
  assert.equal(calls, 0);
});


const TOOL = {
  name: 'document.parse',
  args: {},
  capability: 'document.parse' as const,
  risk: 'low' as const,
};

class ConcurrencyTrackingRunner implements ToolRunner {
  active = 0;
  maxActive = 0;
  readonly finished = new Set<string>();

  async run(node: DAGNode): Promise<{ ok: boolean; outputRef: string }> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolve) => setTimeout(resolve, 8));
    this.active -= 1;
    this.finished.add(node.id);
    return { ok: true, outputRef: `artifact://${node.id}` };
  }
}

test('独立节点使用受控并发执行，且调度统计报告真实最大并发度', async () => {
  const runner = new ConcurrencyTrackingRunner();
  let observedMax = 0;
  const executor = new DAGExecutor(
    { taskId: 'task-parallel', runId: 'run-parallel' },
    () => undefined,
    runner,
    { maxConcurrency: 2 },
    (stats) => { observedMax = stats.maxObservedConcurrency; },
  );
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    id: `independent-${index}`,
    kind: 'tool' as const,
    tool: TOOL,
    deps: [],
  }));

  const stats = await executor.run(nodes);

  assert.equal(runner.maxActive, 2);
  assert.equal(stats.maxObservedConcurrency, 2);
  assert.equal(observedMax, 2);
  assert.equal(stats.completedNodes, 6);
  assert.equal(stats.failedNodes, 0);
});

test('后继节点只在全部依赖完成后入队，且并发调度不会扫描无关节点', async () => {
  const runner = new ConcurrencyTrackingRunner();
  const executor = new DAGExecutor(
    { taskId: 'task-deps', runId: 'run-deps' },
    () => undefined,
    {
      async run(node): Promise<{ ok: boolean; outputRef: string }> {
        if (node.id === 'merge') {
          assert.equal(runner.finished.has('left'), true);
          assert.equal(runner.finished.has('right'), true);
        }
        return runner.run(node);
      },
    },
    { maxConcurrency: 2 },
  );

  const stats = await executor.run([
    { id: 'left', kind: 'tool', tool: TOOL, deps: [] },
    { id: 'right', kind: 'tool', tool: TOOL, deps: [] },
    { id: 'merge', kind: 'tool', tool: TOOL, deps: ['left', 'right'] },
  ]);

  assert.equal(stats.completedNodes, 3);
  assert.equal(runner.maxActive, 2);
});

test('DAG 在执行前拒绝重复节点、重复依赖和未知依赖', async () => {
  const executor = new DAGExecutor(
    { taskId: 'task-invalid', runId: 'run-invalid' },
    () => undefined,
    new SuccessfulRunner(),
  );

  await assert.rejects(
    executor.run([
      { id: 'same', kind: 'tool', tool: TOOL, deps: [] },
      { id: 'same', kind: 'tool', tool: TOOL, deps: [] },
    ]),
    /duplicate DAG node id/,
  );
  await assert.rejects(
    executor.run([{ id: 'repeat', kind: 'tool', tool: TOOL, deps: ['missing', 'missing'] }]),
    /duplicate dependency/,
  );
  await assert.rejects(
    executor.run([{ id: 'unknown', kind: 'tool', tool: TOOL, deps: ['missing'] }]),
    /unknown dependency/,
  );
});


test('DAG 在执行前拒绝空节点标识，避免就绪队列无法推进', async () => {
  const executor = new DAGExecutor(
    { taskId: 'task-empty-id', runId: 'run-empty-id' },
    () => undefined,
    new SuccessfulRunner(),
  );

  await assert.rejects(
    executor.run([{ id: '', kind: 'tool', tool: TOOL, deps: [] }]),
    /不能为空/,
  );
});


test('失败节点会级联阻断所有后继，避免可恢复 DAG 遗留悬空节点', async () => {
  const calls: string[] = [];
  const settlements: string[] = [];
  const executor = new DAGExecutor(
    { taskId: 'task-blocked', runId: 'run-blocked' },
    () => undefined,
    {
      async run(node): Promise<{ ok: boolean; outputRef: string }> {
        calls.push(node.id);
        return { ok: node.id !== 'root', outputRef: `artifact://${node.id}` };
      },
    },
    {
      onNodeSettled: ({ nodeId, outcome }) => settlements.push(`${nodeId}:${outcome}`),
    },
  );

  const stats = await executor.run([
    { id: 'root', kind: 'tool', tool: TOOL, deps: [] },
    { id: 'middle', kind: 'tool', tool: TOOL, deps: ['root'] },
    { id: 'leaf', kind: 'tool', tool: TOOL, deps: ['middle'] },
  ]);

  assert.deepEqual(calls, ['root']);
  assert.equal(stats.failedNodes, 1);
  assert.equal(stats.blockedNodes, 2);
  assert.deepEqual(settlements, ['root:failed', 'middle:blocked', 'leaf:blocked']);
});
