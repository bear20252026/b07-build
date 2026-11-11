import assert from 'node:assert/strict';
import test from 'node:test';

import { listLiveBrowserSessions, liveSessionStatusLabel, toLiveBrowserSession } from '../src/runtime/browser-session-live.js';

// ---------------------------------------------------------------------------
// 浏览会话状态：跨进程边界来的数据必须**验形状**，不能信类型。
// ---------------------------------------------------------------------------

const invokeCalls: string[] = [];
let invokePayload: unknown = [];
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string) => {
      invokeCalls.push(cmd);
      return invokePayload;
    },
  },
};

test('合法会话原样通过', () => {
  assert.deepEqual(toLiveBrowserSession({ sessionId: 's1', targetId: 'tab-1', status: 'active' }), {
    sessionId: 's1',
    targetId: 'tab-1',
    status: 'active',
  });
});

test('在途会话的target允许为null', () => {
  assert.deepEqual(toLiveBrowserSession({ sessionId: 's1', targetId: null, status: 'inflight' }), {
    sessionId: 's1',
    targetId: null,
    status: 'inflight',
  });
});

test('形状不对的条目被丢弃而不是猜', () => {
  // 少显示一条是"看不到"；显示一条假的会让用户对状态做出错误判断。
  for (const bad of [
    null,
    'garbage',
    {},
    { sessionId: '', targetId: null, status: 'active' },
    { sessionId: 's1', targetId: null, status: 'unknown' },
    { sessionId: 's1', targetId: 42, status: 'active' },
    { sessionId: 1, targetId: null, status: 'active' },
  ]) {
    assert.equal(toLiveBrowserSession(bad), undefined, JSON.stringify(bad));
  }
});

test('列会话走browser_sessions_list命令', async () => {
  invokeCalls.length = 0;
  invokePayload = [{ sessionId: 's1', targetId: 'tab-1', status: 'active' }];
  const sessions = await listLiveBrowserSessions();
  assert.deepEqual(invokeCalls, ['browser_sessions_list']);
  assert.equal(sessions.length, 1);
});

test('返回不是数组时给空列表而不是抛', async () => {
  // 原生侧形状意外时，界面应当显示"没有会话"，而不是整个面板崩掉。
  invokePayload = { unexpected: true };
  assert.deepEqual(await listLiveBrowserSessions(), []);
});

test('混入的坏条目被过滤，好的留下', async () => {
  invokePayload = [
    { sessionId: 's1', targetId: 'tab-1', status: 'active' },
    { sessionId: '', targetId: null, status: 'active' },
    { sessionId: 's2', targetId: null, status: 'closing' },
  ];
  const sessions = await listLiveBrowserSessions();
  assert.deepEqual(sessions.map((session) => session.sessionId), ['s1', 's2']);
});

test('状态文案覆盖三种', () => {
  assert.equal(liveSessionStatusLabel('active'), '可用');
  assert.equal(liveSessionStatusLabel('inflight'), '执行中');
  assert.equal(liveSessionStatusLabel('closing'), '正在关闭');
});
