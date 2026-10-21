import assert from 'node:assert/strict';
import test from 'node:test';

import { McpConnectionRegistry, type McpSessionLike } from '../src/runtime/zcode/mcp-connection-registry.js';

// ---------------------------------------------------------------------------
// MCP 连接注册表：`plugin-reference` 的 `liveMcpServers` 就靠它拿数据。
// 这里用假会话，不碰真实进程 —— 起什么进程是安全决策，不在这一层的测试范围。
// ---------------------------------------------------------------------------

interface FakeSession extends McpSessionLike {
  readonly serverId: string;
  connected: number;
  closed: number;
}

function makeSession(serverId: string, behaviour: { tools?: readonly unknown[]; failConnect?: string; delayMs?: number } = {}): FakeSession {
  const session: FakeSession = {
    serverId,
    connected: 0,
    closed: 0,
    async connect() {
      session.connected += 1;
      if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      if (behaviour.failConnect) throw new Error(behaviour.failConnect);
      return {};
    },
    async listTools() {
      return behaviour.tools ?? [];
    },
    async close() {
      session.closed += 1;
    },
  };
  return session;
}

test('连上之后记下工具名', async () => {
  const session = makeSession('hello', { tools: [{ name: 'greet' }, { name: 'wave' }] });
  const registry = new McpConnectionRegistry({ createSession: () => session });
  const snapshot = await registry.connect('hello');
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.toolNames.length, 2);
  for (const name of snapshot.toolNames) assert.match(name, /^mcp__hello__/);
});

test('拿不到启动规格时记成failed而不是抛', async () => {
  // 抛出去会让"有一个没配好的 server"变成"整页打不开"。
  const registry = new McpConnectionRegistry({ createSession: () => undefined });
  const snapshot = await registry.connect('nope');
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.error, 'no-session-spec');
});

test('连接失败时记下原因并关掉会话', async () => {
  const session = makeSession('bad', { failConnect: '握手超时' });
  const registry = new McpConnectionRegistry({ createSession: () => session });
  const snapshot = await registry.connect('bad');
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.error, '握手超时');
  assert.equal(session.closed, 1, '连不上的会话必须收掉，否则退出时留下孤儿进程');
});

test('已ready时重复连接不会重连', async () => {
  const session = makeSession('hello', { tools: [{ name: 'greet' }] });
  const registry = new McpConnectionRegistry({ createSession: () => session });
  await registry.connect('hello');
  await registry.connect('hello');
  assert.equal(session.connected, 1);
});

test('并发连接只起一个会话', async () => {
  const session = makeSession('hello', { tools: [{ name: 'greet' }], delayMs: 10 });
  const registry = new McpConnectionRegistry({ createSession: () => session });
  const [first, second] = await Promise.all([registry.connect('hello'), registry.connect('hello')]);
  assert.equal(session.connected, 1, '并发连接必须复用同一个进行中的请求');
  assert.equal(first, second);
});

test('liveMcpServers只给ready且有工具的', async () => {
  const registry = new McpConnectionRegistry({
    createSession: (serverId) => {
      if (serverId === 'empty') return makeSession('empty', { tools: [] });
      if (serverId === 'broken') return makeSession('broken', { failConnect: 'x' });
      return makeSession(serverId, { tools: [{ name: 'a' }, { name: 'b' }] });
    },
  });
  await registry.connect('good');
  await registry.connect('empty');
  await registry.connect('broken');
  const live = registry.liveMcpServers();
  // 工具数为 0 的 server 列给模型 = 让它去调不存在的工具。
  assert.deepEqual([...live.keys()], ['good']);
  assert.equal(live.get('good')?.providerVisibleToolCount, 2);
});

test('list包含失败项并按id排序', async () => {
  const registry = new McpConnectionRegistry({
    createSession: (serverId) => (serverId === 'b' ? undefined : makeSession(serverId, { tools: [{ name: 't' }] })),
  });
  await registry.connect('c');
  await registry.connect('b');
  await registry.connect('a');
  const list = registry.list();
  assert.deepEqual(list.map((entry) => entry.serverId), ['a', 'b', 'c']);
  assert.equal(list[1].state, 'failed');
});

test('close幂等且真的关会话', async () => {
  const session = makeSession('hello', { tools: [{ name: 'greet' }] });
  const registry = new McpConnectionRegistry({ createSession: () => session });
  await registry.connect('hello');
  await registry.close('hello');
  await registry.close('hello');
  assert.equal(session.closed, 1);
  assert.equal(registry.list().length, 0);
});

test('closeAll关掉全部并清空', async () => {
  const sessions = ['a', 'b'].map((serverId) => makeSession(serverId, { tools: [{ name: 't' }] }));
  const registry = new McpConnectionRegistry({ createSession: (serverId) => sessions.find((session) => session.serverId === serverId) });
  await registry.connect('a');
  await registry.connect('b');
  await registry.closeAll();
  assert.deepEqual(sessions.map((session) => session.closed), [1, 1]);
  assert.equal(registry.list().length, 0);
});

test('关一个失败不挡住其余关闭', async () => {
  const stubborn: FakeSession = { ...makeSession('a'), close: async () => { throw new Error('关不掉'); } };
  const ok = makeSession('b', { tools: [{ name: 't' }] });
  const registry = new McpConnectionRegistry({ createSession: (serverId) => (serverId === 'a' ? stubborn : ok) });
  await registry.connect('a');
  await registry.connect('b');
  await registry.closeAll();
  assert.equal(ok.closed, 1);
});
