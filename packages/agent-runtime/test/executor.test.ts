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
