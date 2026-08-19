import { performance } from 'node:perf_hooks';
import { DAGExecutor, type DAGNode, type ToolRunner } from '../src/executor.js';

const NODE_COUNT = 24;
const WORK_MS = 5;

const tool = {
  name: 'benchmark.noop',
  args: {},
  capability: 'document.parse' as const,
  risk: 'low' as const,
};

class TimedRunner implements ToolRunner {
  async run(_node: DAGNode): Promise<{ ok: boolean; outputRef: string }> {
    await new Promise<void>((resolve) => setTimeout(resolve, WORK_MS));
    return { ok: true, outputRef: 'benchmark://ok' };
  }
}

async function measure(maxConcurrency: number): Promise<{ maxConcurrency: number; elapsedMs: number; observed: number }> {
  let observed = 0;
  const executor = new DAGExecutor(
    { taskId: 'benchmark-task', runId: `benchmark-${maxConcurrency}` },
    () => undefined,
    new TimedRunner(),
    { maxConcurrency },
    (stats) => { observed = stats.maxObservedConcurrency; },
  );
  const nodes = Array.from({ length: NODE_COUNT }, (_, index) => ({
    id: `node-${index}`,
    kind: 'tool' as const,
    tool,
    deps: [],
  }));
  const startedAt = performance.now();
  await executor.run(nodes);
  return {
    maxConcurrency,
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    observed,
  };
}

const serial = await measure(1);
const pooled = await measure(4);
console.table([
  { mode: 'serial', ...serial },
  { mode: 'pool-4', ...pooled, speedup: Number((serial.elapsedMs / pooled.elapsedMs).toFixed(2)) },
]);
