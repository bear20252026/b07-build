import assert from 'node:assert/strict';
import test from 'node:test';
import { ZCodeProtocolClient, ZCodeProtocolError } from '../src/runtime/zcode/zcode-protocol-client';

/** 进程面内存桩：start 返回后由测试手动喂 stdout 行。 */
function fakeTransport() {
  const written: string[] = [];
  const stopped: string[] = [];
  let onLine: ((payload: { runId: string; stream: 'stdout' | 'stderr'; text: string }) => void) | undefined;
  let onExit: ((payload: { runId: string; code: number | null }) => void) | undefined;
  return {
    written,
    stopped,
    feed(line: string): void { onLine?.({ runId: 'zcode-test', stream: 'stdout', text: line }); },
    feedStderr(line: string): void { onLine?.({ runId: 'zcode-test', stream: 'stderr', text: line }); },
    exit(code: number | null): void { onExit?.({ runId: 'zcode-test', code }); },
    deps: {
      start: async (runId: string) => { assert.equal(runId, 'zcode-test'); },
      writeLine: async (_runId: string, line: string) => { written.push(line); },
      stop: async (runId: string) => { stopped.push(runId); },
      subscribe: async (handlers: { onLine: typeof onLine; onExit: typeof onExit }) => {
        onLine = handlers.onLine;
        onExit = handlers.onExit;
        return () => undefined;
      },
    },
  };
}

test('请求/应答按 id 关联，非 JSON 行与 stderr 不进关联', async () => {
  const transport = fakeTransport();
  const client = new ZCodeProtocolClient({ executable: 'zcode', runId: 'zcode-test', deps: transport.deps, requestTimeoutMs: 1000 });
  await client.start();
  const pending = client.request('session/create', { workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' } });
  assert.deepEqual(JSON.parse(transport.written[0]!), { id: 1, method: 'session/create', params: { workspace: { workspacePath: 'D:/repo', workspaceKey: 'D:/repo' } } });
  transport.feed('not json at all');
  transport.feedStderr('diag log');
  transport.feed(JSON.stringify({ id: 1, result: { sessionId: 'sess_1' } }));
  assert.deepEqual(await pending, { sessionId: 'sess_1' });
  assert.equal(client.recentStderr().at(-1), 'diag log');
  await client.close();
});

test('协议错误应答以 ZCodeProtocolError 冒出并携带服务端消息', async () => {
  const transport = fakeTransport();
  const client = new ZCodeProtocolClient({ executable: 'zcode', runId: 'zcode-test', deps: transport.deps, requestTimeoutMs: 1000 });
  await client.start();
  const pending = client.request('session/send', {});
  transport.feed(JSON.stringify({ id: 1, error: { code: -32602, message: 'Invalid params' } }));
  await assert.rejects(pending, (error: unknown) => error instanceof ZCodeProtocolError && /Invalid params/.test(error.message));
  await client.close();
});

test('通知按 method 分发给监听器，子进程退出后挂起请求全部拒绝', async () => {
  const transport = fakeTransport();
  const client = new ZCodeProtocolClient({ executable: 'zcode', runId: 'zcode-test', deps: transport.deps, requestTimeoutMs: 5000 });
  await client.start();
  const notifications: { method: string; params: unknown }[] = [];
  client.onNotification((method, params) => notifications.push({ method, params }));
  transport.feed(JSON.stringify({ method: 'session/state.updated', params: { seq: 1 } }));
  assert.deepEqual(notifications, [{ method: 'session/state.updated', params: { seq: 1 } }]);
  const pending = client.request('session/send', { sessionId: 'sess_1', content: 'hi' });
  transport.exit(0);
  await assert.rejects(pending, (error: unknown) => error instanceof ZCodeProtocolError && error.message.includes('zcode-transport-closed') === false && /已退出/.test(error.message));
  assert.equal(client.isExited, true);
  await client.close();
  assert.deepEqual(transport.stopped, ['zcode-test']);
});

test('退出后不再发送新请求', async () => {
  const transport = fakeTransport();
  const client = new ZCodeProtocolClient({ executable: 'zcode', runId: 'zcode-test', deps: transport.deps, requestTimeoutMs: 1000 });
  await client.start();
  transport.exit(null);
  await assert.rejects(client.request('session/list'), (error: unknown) => error instanceof ZCodeProtocolError && /已退出/.test(error.message));
});
