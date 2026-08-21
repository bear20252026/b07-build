import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSessionControlPlane, InMemoryBrowserSessionStore, SqliteBrowserSessionStore } from '../src/browser-session-control.js';

function ids(...values: string[]): () => string { let index = 0; return () => values[index++] ?? `extra-${index}`; }

test('浏览会话必须显式授权，暂停后才能恢复，结束后不可恢复或执行', () => {
  const control = new BrowserSessionControlPlane(new InMemoryBrowserSessionStore(), ids('session-1', 'event-1', 'event-2', 'event-3', 'event-4', 'event-5'));
  const requested = control.create({ requestedBy: 'local-user', targetUrl: 'https://docs.example.com/private/path?secret=nope', at: 1, reason: '研究公开文档' });
  assert.deepEqual({ status: requested.status, targetHost: requested.targetHost, canExecute: requested.canExecute, canReadPageContent: requested.canReadPageContent, canReadBrowserSecrets: requested.canReadBrowserSecrets, canControlDesktop: requested.canControlDesktop }, { status: 'requested', targetHost: 'docs.example.com', canExecute: false, canReadPageContent: false, canReadBrowserSecrets: false, canControlDesktop: false });
  assert.equal(requested.scopeDigest.length, 64);
  assert.equal(JSON.stringify(requested).includes('/private/path'), false);
  const authorized = control.authorize(requested.sessionId, 'local-user', 2);
  assert.equal(authorized.status, 'authorized');
  const paused = control.pause(requested.sessionId, 'local-user', 3, '用户暂停');
  assert.equal(paused.status, 'paused');
  assert.equal(control.resume(requested.sessionId, 'local-user', 4).status, 'authorized');
  assert.equal(control.end(requested.sessionId, 'local-user', 5, '用户结束').status, 'ended');
  assert.throws(() => control.resume(requested.sessionId, 'local-user', 6), /paused/);
  assert.deepEqual(control.events(requested.sessionId).map((event) => event.type), ['ended', 'resumed', 'paused', 'authorized', 'requested']);
});

test('浏览会话拒绝不安全目标，SQLite 账本可重开且保持脱敏投影', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-browser-session-'));
  const path = join(directory, 'browser-sessions.sqlite');
  try {
    const firstStore = new SqliteBrowserSessionStore(path);
    const first = new BrowserSessionControlPlane(firstStore, ids('session-2', 'event-11', 'event-12'));
    assert.throws(() => first.create({ requestedBy: 'local-user', targetUrl: 'http://example.com', at: 1 }), /HTTPS/);
    assert.throws(() => first.create({ requestedBy: 'local-user', targetUrl: 'https://localhost:4318', at: 1 }), /本机/);
    const session = first.create({ requestedBy: 'local-user', targetUrl: 'https://www.example.com/with/a/path', at: 1 });
    first.authorize(session.sessionId, 'local-user', 2);
    firstStore.close();
    const secondStore = new SqliteBrowserSessionStore(path);
    const second = new BrowserSessionControlPlane(secondStore);
    const reloaded = second.list();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]?.targetHost, 'www.example.com');
    assert.equal(JSON.stringify(reloaded[0]).includes('/with/a/path'), false);
    secondStore.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
