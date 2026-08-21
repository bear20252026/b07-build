import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpBrowserSessionClient } from '../src/runtime/browser-session-client.js';

const session = {
  schemaVersion: 1, sessionId: 'browser:00000000-0000-4000-8000-000000000001', revision: 1, status: 'requested', adapterId: 'browser.local-preview',
  targetHost: 'docs.example.com', scopeDigest: 'a'.repeat(64), requestedBy: 'local.operator', createdAt: 1_000, updatedAt: 1_000, updatedBy: 'local.operator',
  canExecute: false, canReadPageContent: false, canReadBrowserSecrets: false, canControlDesktop: false,
};

const event = {
  schemaVersion: 1, eventId: 'browser-event:00000000-0000-4000-8000-000000000001', sessionId: session.sessionId, revision: 1,
  type: 'requested', at: 1_000, by: 'local.operator', canExecute: false,
};

test('浏览会话客户端仅读取脱敏会话/审计，并使用固定本机 Gateway 地址', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url) => { urls.push(String(url)); return Response.json(String(url).includes('/events') ? [event] : [session]); }) as typeof fetch;
  try {
    const client = new HttpBrowserSessionClient('http://127.0.0.1:4318/api/browser-sessions');
    const sessions = await client.list();
    const events = await client.events(session.sessionId);
    assert.equal(sessions[0]?.targetHost, 'docs.example.com');
    assert.equal(sessions[0]?.canReadBrowserSecrets, false);
    assert.equal(events[0]?.canExecute, false);
    assert.equal(JSON.stringify(sessions[0]).includes('targetUrl'), false);
    assert.deepEqual(urls, [
      'http://127.0.0.1:4318/api/browser-sessions?limit=100',
      'http://127.0.0.1:4318/api/browser-sessions/browser%3A00000000-0000-4000-8000-000000000001/events?limit=100',
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test('浏览会话客户端只可通过显式 intent 创建和改变受控状态', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url, init) => { requests.push({ url: String(url), init }); return Response.json(session); }) as typeof fetch;
  try {
    const client = new HttpBrowserSessionClient('http://127.0.0.1:4318/api/browser-sessions');
    await client.create({ by: 'local.operator', targetUrl: 'https://docs.example.com/private/path?secret=never-returned', reason: 'review' });
    await client.transition(session.sessionId, 'authorize', { by: 'local.operator' });
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[0]?.init?.headers).get('x-awo-operator-intent'), 'browser-session-create-v1');
    assert.equal(new Headers(requests[1]?.init?.headers).get('x-awo-operator-intent'), 'browser-session-authorize-v1');
    assert.equal(requests[0]?.url, 'http://127.0.0.1:4318/api/browser-sessions');
    assert.equal(requests[1]?.url, 'http://127.0.0.1:4318/api/browser-sessions/browser%3A00000000-0000-4000-8000-000000000001/authorize');
    assert.equal(String(requests[0]?.init?.body).includes('never-returned'), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('浏览会话客户端拒绝未知字段及本机目标，避免向 UI 传播秘密或本机浏览范围', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json([{ ...session, targetUrl: 'https://docs.example.com/private' }])) as typeof fetch;
  try {
    await assert.rejects(() => new HttpBrowserSessionClient().list(), /未声明、敏感或可执行字段/);
    await assert.rejects(() => new HttpBrowserSessionClient().create({ by: 'local.operator', targetUrl: 'https://localhost/secret' }), /仅允许公网 HTTPS 主机/);
  } finally { globalThis.fetch = originalFetch; }
});
