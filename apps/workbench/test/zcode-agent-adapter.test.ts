import assert from 'node:assert/strict';
import test from 'node:test';
import { ZCodeAgentAdapter } from '../src/runtime/zcode/zcode-agent-adapter';
import type { ZCodeProtocolDeps } from '../src/runtime/zcode/zcode-protocol-client';

interface Frame { readonly id?: number; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string }; }
type Outcome = { readonly result?: unknown } | undefined;

/**
 * 协议面内存桩：记录写入帧，不自动回帧；测试用 pump(method, outcome) 决定
 * 应答时序（真实链路里这就是子进程从 stdout 回帧），feedLine 注入通知/反向请求帧。
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
    /** 纯等待：让无应答的写入帧（respond/resync）落盘并让微任务跑完。 */
    settle: (ms = 25): Promise<void> => waitMs(ms),
    methods() { return written.map((frame) => frame.method).filter((method): method is string => typeof method === 'string'); },
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

test('适配器最小闭环：connect 创建会话并订阅事件流，send 提交输入，事件按信封分发', async () => {
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
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 0, events: [] } } : undefined);
  assert.equal(await connectPromise, 'sess_abc');
  assert.deepEqual(JSON.parse(JSON.stringify(transport.written[0]!.params)), { workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' } });
  assert.deepEqual(JSON.parse(JSON.stringify(transport.written[1]!.params)), { sessionId: 'sess_abc', deliveryKind: 'desktop-continuous', includeSnapshot: false });

  const sendPromise = adapter.send('帮我跑一遍测试', 'input-1');
  await transport.pump((frame) => frame.method === 'session/send' ? { result: {} } : undefined);
  await sendPromise;
  assert.deepEqual(JSON.parse(JSON.stringify(transport.written[2]!.params)), { sessionId: 'sess_abc', inputId: 'input-1', content: '帮我跑一遍测试' });

  // 协议 seq 从 1 起（服务端 assignProtocolEventSeq：lastSeq 初始 0，首个事件 seq=1）。
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'e1', sessionId: 'sess_abc', seq: 1, timestamp: 1, extra: 'payload' } }));
  assert.deepEqual(events.at(-1), {
    kind: 'event',
    method: 'session/state.updated',
    envelope: { eventId: 'e1', sessionId: 'sess_abc', seq: 1, timestamp: 1 },
    payload: { extra: 'payload' },
  });

  await adapter.close();
  assert.deepEqual(transport.methods(), ['session/create', 'session/subscribe', 'session/send', 'session/close']);
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

test('权限反向请求无裁决回调时以完整协议应答执行 deny（fail-closed）', async () => {
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
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 0, events: [] } } : undefined);
  await connectPromise;
  transport.feedLine(JSON.stringify({ id: 7, method: 'interaction/requestPermission', params: { requestId: 'p1', toolName: 'bash' } }));
  await transport.settle(); // 让 respond 帧落盘并让微任务跑完
  const respondFrame = transport.written.find((frame) => frame.method === undefined && frame.id === 7);
  assert.deepEqual(JSON.parse(JSON.stringify(respondFrame)), { id: 7, result: { decision: 'deny', reason: 'no permission handler attached' } });
  transport.feedLine(JSON.stringify({ method: 'startup/storageState', params: { phase: 'ready' } }));
  assert.deepEqual(events, [{ kind: 'notification', method: 'startup/storageState', payload: { phase: 'ready' } }]);
  await adapter.close();
});

test('裁决回调的 respond 以完整协议应答回发 decision/reason', async () => {
  const transport = fakeTransport();
  const adapter = new ZCodeAgentAdapter({
    executable: 'zcode',
    workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' },
    deps: transport.deps,
    runId: 'zcode-test',
    onPermissionRequest: ({ respond }) => respond('allow', 'user approved'),
  });
  const connectPromise = adapter.connect();
  await transport.pump((frame) => frame.method === 'session/create' ? { result: { sessionId: 'sess_abc' } } : undefined);
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 0, events: [] } } : undefined);
  await connectPromise;
  transport.feedLine(JSON.stringify({ id: 'srv-1', method: 'interaction/requestPermission', params: { toolName: 'bash' } }));
  await transport.settle();
  const respondFrame = transport.written.find((frame) => frame.method === undefined && frame.id === 'srv-1');
  assert.deepEqual(JSON.parse(JSON.stringify(respondFrame)), { id: 'srv-1', result: { decision: 'allow', reason: 'user approved' } });
  await adapter.close();
});

test('双会话隔离：其它会话的事件不推进当前水位也不进入投影', async () => {
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
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 0, events: [] } } : undefined);
  await connectPromise;

  // 另一个会话的「合法形状」事件：sessionId 不匹配 → 必须整体忽略。
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'other-1', sessionId: 'sess_OTHER', seq: 1, timestamp: 2, type: 'turn.started', payload: { turnNumber: 1 } } }));
  await transport.settle();
  assert.equal(events.length, 0, '外来会话事件不得进入投影');
  // 伪造信封想抢占水位：seq 5 的外来事件之后，本会话 seq 1 的事件仍按缺口语义正常处理。
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'own-1', sessionId: 'sess_abc', seq: 1, timestamp: 3, type: 'turn.started', payload: { turnNumber: 1 } } }));
  await transport.settle();
  const kinds = events.map((event) => (event as { kind: string }).kind);
  assert.deepEqual(kinds, ['event']);
  await adapter.close();
});

test('未支持的反向请求立即以 -32601 错误帧拒绝', async () => {
  const transport = fakeTransport();
  const adapter = new ZCodeAgentAdapter({
    executable: 'zcode',
    workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' },
    deps: transport.deps,
    runId: 'zcode-test',
  });
  const connectPromise = adapter.connect();
  await transport.pump((frame) => frame.method === 'session/create' ? { result: { sessionId: 'sess_abc' } } : undefined);
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 0, events: [] } } : undefined);
  await connectPromise;
  transport.feedLine(JSON.stringify({ id: 9, method: 'interaction/requestProviderRuntimeHeaders', params: {} }));
  await transport.settle();
  const respondFrame = transport.written.find((frame) => frame.method === undefined && frame.id === 9);
  assert.deepEqual(JSON.parse(JSON.stringify(respondFrame)), { id: 9, error: { code: -32601, message: 'unsupported server request: interaction/requestProviderRuntimeHeaders' } });
  await adapter.close();
});

test('事件 seq 缺口触发 session/subscribe(afterSeq) 重同步并补发事件', async () => {
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
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 0, events: [] } } : undefined);
  await connectPromise;

  // 协议 seq 从 1 起：seq 3 跳过 1/2 形成缺口（seq 0 不存在于协议流中）→ 触发 afterSeq 重同步。
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'e3', sessionId: 'sess_abc', seq: 3, timestamp: 4, extra: 'gap' } }));
  await transport.pump((frame) => frame.method === 'session/subscribe' && (frame.params as { afterSeq?: number })?.afterSeq === 0 ? { result: { sessionId: 'sess_abc', eventSeq: 3, events: [
    { eventId: 'e1', sessionId: 'sess_abc', seq: 1, timestamp: 2, type: 'turn.started', payload: { turnNumber: 1 } },
    { eventId: 'e2', sessionId: 'sess_abc', seq: 2, timestamp: 3, type: 'message.upserted', payload: { content: 'hi' } },
  ] } } : undefined);
  await transport.settle();

  const kinds = events.map((event) => (event as { kind: string }).kind);
  assert.deepEqual(kinds, ['event', 'event', 'event']);
  const resynced = events as { method: string; envelope: { seq: number }; payload: unknown }[];
  assert.deepEqual(resynced.map((event) => event.method), ['turn.started', 'message.upserted', 'session/state.updated']);
  assert.deepEqual(resynced.map((event) => event.envelope.seq), [1, 2, 3]);

  // 重复 seq 不再分发（水位去重）。
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'e2-dup', sessionId: 'sess_abc', seq: 2, timestamp: 3, extra: 'dup' } }));
  assert.equal(events.length, 3);
  await adapter.close();
});
