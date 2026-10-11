import assert from 'node:assert/strict';
import test from 'node:test';
import { ZCodeAgentAdapter } from '../src/runtime/zcode/zcode-agent-adapter';
import type { ZCodeProtocolDeps } from '../src/runtime/zcode/zcode-protocol-client';

interface Frame { readonly id: number; readonly method: string; readonly params?: unknown; }
type Outcome = { readonly result?: unknown } | undefined;

/**
 * 协议面内存桩：记录写入帧，不自动回帧；测试用 pump(method, outcome) 决定
 * 应答时序（真实链路里这就是子进程从 stdout 回帧），feedLine 注入通知帧。
 */
function fakeTransport() {
  const written: Frame[] = [];
  const handlers: { onLine: (payload: { runId: string; stream: 'stdout' | 'stderr'; text: string }) => void }[] = [];
  let stopped = false;
  const deps: ZCodeProtocolDeps = {
    start: async () => undefined,
    writeLine: async (_runId: string, line: string) => { written.push(JSON.parse(line)); },
    stop: async () => { stopped = true; },
    subscribe: async (all) => { handlers.push(all); return () => undefined; },
  };
  const feedLine = (line: string): void => { handlers[0]?.onLine({ runId: 'zcode-test', stream: 'stdout', text: line }); };
  const waitMs = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)); };
  return {
    deps,
    written,
    get stopped() { return stopdescriptor(); },
    feedLine,
    methods() { return written.map((frame) => frame.method); },
    /** 等到目标方法的帧出现，然后喂回对应 id 的应答。 */
    async pump(match: (frame: Frame) => Outcome, timeoutMs = 1000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const frame of written) {
          const outcome = match(frame);
          if (outcome) {
            feedLine(JSON.stringify({ id: frame.id, result: outcome.result ?? {} }));
            return;
          }
        }
        await waitMs(5);
      }
      assert.fail(`等待应答帧超时：${written.map((frame) => frame.method).join(',')}`);
    },
  };
  function stopdescriptor() { return stopped; }
}

test('适配器最小闭环：connect 创建会话，send 提交输入，事件按信封分发', async () => {
  const transport = fakeTransport();
  const events: unknown[] = [];
  const adapter = new ZCodeAgentAdapter({
    executable: 'zcode',
    workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' },
    deps: transport.deps,
    runId: 'zcode-test',
    onEvent: (event) => events.push(event),
  });
  const connectPromise = adapter.connect();
  await transport.pump((frame) => frame.method === 'session/create' ? { result: { sessionId: 'sess_abc' } } : undefined);
  assert.equal(await connectPromise, 'sess_abc');
  assert.deepEqual(JSON.parse(JSON.stringify(transport.written[0]!.params)), { workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' } });

  const sendPromise = adapter.send('帮我跑一遍测试', 'input-1');
  await transport.pump((frame) => frame.method === 'session/send' ? { result: {} } : undefined);
  await sendPromise;
  assert.deepEqual(JSON.parse(JSON.stringify(transport.written[1]!.params)), { sessionId: 'sess_abc', inputId: 'input-1', content: '帮我跑一遍测试' });

  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'e1', sessionId: 'sess_abc', seq: 0, timestamp: 1, extra: 'payload' } }));
  assert.deepEqual(events.at(-1), {
    kind: 'event',
    method: 'session/state.updated',
    envelope: { eventId: 'e1', sessionId: 'sess_abc', seq: 0, timestamp: 1 },
    payload: { extra: 'payload' },
  });

  await adapter.close();
  assert.deepEqual(transport.methods(), ['session/create', 'session/send', 'session/close']);
});

test('connect 拿不到 sessionId 时停止子进程并抛错，适配器回到未连接态', async () => {
  const transport = fakeTransport();
  const adapter = new ZCodeAgentAdapter({ executable: 'zcode', workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' }, deps: transport.deps, runId: 'zcode-test' });
  const connectPromise = adapter.connect();
  await transport.pump((frame) => frame.method === 'session/create' ? { result: {} } : undefined);
  await assert.rejects(connectPromise, /zcode-session-id-missing/);
  assert.equal(transport.stopped, true);
  assert.equal(adapter.processId, undefined);
  assert.equal(adapter.sessionId, undefined);
});

test('权限反向请求在无裁决回调时不崩溃（最小集成 fail-closed），普通通知原样转发', async () => {
  const transport = fakeTransport();
  const events: unknown[] = [];
  const adapter = new ZCodeAgentAdapter({
    executable: 'zcode',
    workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' },
    deps: transport.deps,
    runId: 'zcode-test',
    onEvent: (event) => events.push(event),
  });
  const connectPromise = adapter.connect();
  await transport.pump((frame) => frame.method === 'session/create' ? { result: { sessionId: 'sess_abc' } } : undefined);
  await connectPromise;
  transport.feedLine(JSON.stringify({ method: 'interaction/requestPermission', params: { id: 'p1', toolName: 'bash' } }));
  transport.feedLine(JSON.stringify({ method: 'startup/storageState', params: { phase: 'ready' } }));
  // 权限反向请求不是事件信封也不是普通通知：它被拦截等待裁决，这里没有回调，什么都不应发生。
  assert.deepEqual(events, [{ kind: 'notification', method: 'startup/storageState', payload: { phase: 'ready' } }]);
  await adapter.close();
});
