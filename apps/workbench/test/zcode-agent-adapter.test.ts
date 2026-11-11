import assert from 'node:assert/strict';
import test from 'node:test';
import { ZCodeAgentAdapter } from '../src/runtime/zcode/zcode-agent-adapter';
import type { ZCodeProtocolDeps } from '../src/runtime/zcode/zcode-protocol-client';

interface Frame { readonly id?: number | string; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string }; }
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

/** 建立连接的最小公共前置：create + subscribe（ACK 为空流）。 */
async function connected(transport: ReturnType<typeof fakeTransport>, options: ConstructorParameters<typeof ZCodeAgentAdapter>[0]): Promise<ZCodeAgentAdapter> {
  const adapter = new ZCodeAgentAdapter(options);
  const connectPromise = adapter.connect();
  await transport.pump((frame) => frame.method === 'session/create' ? { result: { sessionId: 'sess_abc' } } : undefined);
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 0, events: [] } } : undefined);
  await connectPromise;
  return adapter;
}

test('命令幂等：同 commandId 在途不重复写线，已裁决重放直接复用原裁决', async () => {
  const transport = fakeTransport();
  const adapter = await connected(transport, { executable: 'zcode', workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' }, deps: transport.deps, runId: 'zcode-test' });

  const inFlight = adapter.send('帮我跑一遍测试', 'input-1');
  const dup = await adapter.send('帮我跑一遍测试', 'input-1');
  assert.equal(dup.kind, 'in-flight', '重复提交必须零副作用');
  assert.equal(transport.written.filter((frame) => frame.method === 'session/send').length, 1);

  await transport.pump((frame) => frame.method === 'session/send' ? { result: { accepted: true } } : undefined);
  const sent = await inFlight;
  assert.equal(sent.kind, 'sent');
  assert.equal(sent.ack.status, 'accepted');

  const replay = await adapter.send('帮我跑一遍测试', 'input-1');
  assert.equal(replay.kind, 'settled');
  assert.equal(replay.kind === 'settled' ? replay.ack.commandId : undefined, 'input-1');
  assert.equal(transport.written.filter((frame) => frame.method === 'session/send').length, 1, '重放不产生第二次副作用');
  await adapter.close();
});

test('同 commandId 换内容是串号提交：明确失败，绝不猜该返回哪个结果', async () => {
  const transport = fakeTransport();
  const adapter = await connected(transport, { executable: 'zcode', workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' }, deps: transport.deps, runId: 'zcode-test' });
  const first = adapter.send('原内容', 'input-1');
  await transport.pump((frame) => frame.method === 'session/send' ? { result: {} } : undefined);
  await first;
  await assert.rejects(adapter.send('换了内容', 'input-1'), /session-command-id-reused-with-different-payload/);
  assert.equal(transport.written.filter((frame) => frame.method === 'session/send').length, 1);
  await adapter.close();
});

test('CAS：基准取会话权威水位，-32009 判 stale 后带对端实际水位重发一次且幂等键不变', async () => {
  const transport = fakeTransport();
  const adapter = await connected(transport, { executable: 'zcode', workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' }, deps: transport.deps, runId: 'zcode-test' });
  // 会话结构水位的唯一事件来源：state.updated.revision。
  transport.feedLine(JSON.stringify({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: 'sess_abc', revision: 7 } }));
  await transport.settle();

  const sendPromise = adapter.send('换成 build 模式', 'input-9');
  await transport.settle();
  const sends = () => transport.written.filter((frame) => frame.method === 'session/send');
  assert.equal(sends().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sends()[0]!.params)), { sessionId: 'sess_abc', inputId: 'input-9', content: '换成 build 模式', expectedRevision: 7 });

  const firstId = sends()[0]!.id;
  transport.feedLine(JSON.stringify({ id: firstId, error: { code: -32009, message: 'Session state revision mismatch', data: { actualRevision: 9, expectedRevision: 7 } } }));
  await transport.settle();
  assert.equal(sends().length, 2, 'stale 表示准入即拒、零副作用，允许带新基准重试一次');
  assert.deepEqual(JSON.parse(JSON.stringify(sends()[1]!.params)), { sessionId: 'sess_abc', inputId: 'input-9', content: '换成 build 模式', expectedRevision: 9 });

  transport.feedLine(JSON.stringify({ id: sends()[1]!.id, result: { accepted: true } }));
  const sent = await sendPromise;
  assert.equal(sent.kind, 'sent');
  assert.equal(sent.ack.status, 'accepted');
  assert.equal(sent.command.commandId, 'input-9', '重发复用原命令，不换幂等键');
  await adapter.close();
});

test('stale 但对端未回实际水位：不盲目重发；沿用同一过期基准重试被识破，收敛到新水位后才复用幂等键', async () => {
  const transport = fakeTransport();
  const adapter = await connected(transport, { executable: 'zcode', workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' }, deps: transport.deps, runId: 'zcode-test' });
  transport.feedLine(JSON.stringify({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: 'sess_abc', revision: 7 } }));
  await transport.settle();
  const sends = () => transport.written.filter((frame) => frame.method === 'session/send');

  const first = adapter.send('换模式', 'input-9');
  await transport.settle();
  transport.feedLine(JSON.stringify({ id: sends()[0]!.id, error: { code: -32009, message: 'Session state revision mismatch' } }));
  await assert.rejects(first);
  assert.equal(sends().length, 1, '水位未知即不重放：带着同一过期基准重试只是空转');

  await assert.rejects(adapter.send('换模式', 'input-9'), /session-command-stale-base-reused/);
  assert.equal(sends().length, 1);

  // 先收敛（采纳新的权威水位），再带新基准复用同一 commandId 重发。
  transport.feedLine(JSON.stringify({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', sessionId: 'sess_abc', revision: 9 } }));
  await transport.settle();
  const retry = adapter.send('换模式', 'input-9');
  await transport.settle();
  assert.equal(sends().length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(sends()[1]!.params)), { sessionId: 'sess_abc', inputId: 'input-9', content: '换模式', expectedRevision: 9 });
  transport.feedLine(JSON.stringify({ id: sends()[1]!.id, result: { accepted: true } }));
  const sent = await retry;
  assert.equal(sent.kind, 'sent');
  await adapter.close();
});

test('补齐轮仍填不上洞即升级为 includeSnapshot 权威快照，快照覆盖的缓存不再单独放行', async () => {
  const transport = fakeTransport();
  const events: unknown[] = [];
  const adapter = await connected(transport, { executable: 'zcode', workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' }, deps: transport.deps, runId: 'zcode-test', onEvent: (event) => events.push(event) });
  const envelope = (seq: number): string => JSON.stringify({ method: 'session/state.updated', params: { eventId: `n${seq}`, sessionId: 'sess_abc', seq, timestamp: seq } });
  transport.feedLine(envelope(3));
  await transport.pump((frame) => (frame.params as { afterSeq?: number })?.afterSeq === 0 ? { result: { sessionId: 'sess_abc', eventSeq: 5, events: [
    { eventId: 'e5', sessionId: 'sess_abc', seq: 5, timestamp: 5, type: 'message.upserted', payload: { content: 'hi' } },
  ] } } : undefined);
  assert.equal(events.length, 0, 'seq 4 仍缺 → 一条都不放行');

  await transport.pump((frame) => (frame.params as { includeSnapshot?: boolean })?.includeSnapshot === true ? { result: { sessionId: 'sess_abc', eventSeq: 6, snapshot: { runtime: { eventSeq: 6 }, messages: [] } } } : undefined, 4000);
  await transport.settle();
  // 逐条断言而非整数组 deepEqual：后者会把 events 收窄成快照那一条的类型。
  assert.deepEqual(events.at(-1), { kind: 'notification', method: 'session/snapshot', payload: { runtime: { eventSeq: 6 }, messages: [] } });
  assert.equal(adapter.isStreamIncomplete, false);
  transport.feedLine(envelope(7));
  assert.equal((events.at(-1) as { kind: string; envelope: { seq: number } }).envelope.seq, 7, '快照水位之后按新基准续播');
  await adapter.close();
});

test('close 作废水位与在途补齐：迟到的补发结果不再进入投影', async () => {
  const transport = fakeTransport();
  const events: unknown[] = [];
  const adapter = await connected(transport, { executable: 'zcode', workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' }, deps: transport.deps, runId: 'zcode-test', onEvent: (event) => events.push(event) });
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'e4', sessionId: 'sess_abc', seq: 4, timestamp: 4 } }));
  await transport.settle();
  const resyncFrame = transport.written.filter((frame) => frame.method === 'session/subscribe').at(-1)!;
  await adapter.close();
  transport.feedLine(JSON.stringify({ id: resyncFrame.id, result: { sessionId: 'sess_abc', eventSeq: 4, events: [
    { eventId: 'e1', sessionId: 'sess_abc', seq: 1, timestamp: 1, type: 'turn.started', payload: {} },
  ] } }));
  await transport.settle(1800);
  assert.deepEqual(events, [], '会话已关闭：上一轮的补齐结果按世代作废');
  assert.equal(transport.written.filter((frame) => frame.method === 'session/subscribe').length, 2, '停摆后不再重订阅');
});

test('订阅 ACK 的补发批按批首锚定基准，顺序放行且不与后续通知重复', async () => {
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
  await transport.pump((frame) => frame.method === 'session/subscribe' ? { result: { sessionId: 'sess_abc', eventSeq: 3, events: [
    { eventId: 'e1', sessionId: 'sess_abc', seq: 1, timestamp: 1, type: 'turn.started', payload: { turnNumber: 1 } },
    { eventId: 'e2', sessionId: 'sess_abc', seq: 2, timestamp: 2, type: 'message.upserted', payload: { content: 'a' } },
    { eventId: 'e3', sessionId: 'sess_abc', seq: 3, timestamp: 3, type: 'turn.completed', payload: {} },
  ] } } : undefined);
  await connectPromise;
  const seqs = () => events.map((event) => (event as { envelope: { seq: number } }).envelope.seq);
  assert.deepEqual(seqs(), [1, 2, 3], 'ACK 补发批按序进入投影');
  // 批内已放行的序号再作为通知到达即重复：水位去重，不得二次生效。
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'e2-dup', sessionId: 'sess_abc', seq: 2, timestamp: 2, type: 'message.upserted', payload: { content: 'a' } } }));
  await transport.settle();
  assert.deepEqual(seqs(), [1, 2, 3]);
  const subscribes = () => transport.written.filter((frame) => frame.method === 'session/subscribe').length;
  assert.equal(subscribes(), 1, 'eventSeq 与批尾一致即无缺口，不该重订阅');
  transport.feedLine(JSON.stringify({ method: 'session/state.updated', params: { eventId: 'e5', sessionId: 'sess_abc', seq: 5, timestamp: 5, type: 'turn.started', payload: {} } }));
  await transport.pump((frame) => (frame.params as { afterSeq?: number })?.afterSeq === 3 ? { result: { sessionId: 'sess_abc', eventSeq: 5, events: [
    { eventId: 'e4', sessionId: 'sess_abc', seq: 4, timestamp: 4, type: 'message.upserted', payload: { content: 'b' } },
  ] } } : undefined);
  await transport.settle();
  assert.deepEqual(seqs(), [1, 2, 3, 4, 5]);
  assert.equal(subscribes(), 2);
  await adapter.close();
});
