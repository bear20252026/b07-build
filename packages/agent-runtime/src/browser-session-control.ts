import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BROWSER_SESSION_SCHEMA_VERSION = 1 as const;
export type BrowserSessionStatus = 'requested' | 'authorized' | 'paused' | 'ended' | 'failed';
export type BrowserSessionEventType = 'requested' | 'authorized' | 'paused' | 'resumed' | 'ended' | 'failed';
export type BrowserAdapterId = 'browser.local-preview';

export interface BrowserSessionSnapshotV1 {
  schemaVersion: typeof BROWSER_SESSION_SCHEMA_VERSION;
  sessionId: string;
  revision: number;
  status: BrowserSessionStatus;
  adapterId: BrowserAdapterId;
  targetHost: string;
  scopeDigest: string;
  requestedBy: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  reason?: string;
  canExecute: false;
  canReadPageContent: false;
  canReadBrowserSecrets: false;
  canControlDesktop: false;
}

export interface BrowserSessionEventV1 {
  schemaVersion: typeof BROWSER_SESSION_SCHEMA_VERSION;
  eventId: string;
  sessionId: string;
  revision: number;
  type: BrowserSessionEventType;
  at: number;
  by: string;
  reason?: string;
  canExecute: false;
}

export interface CreateBrowserSessionRequest {
  requestedBy: string;
  targetUrl: string;
  at: number;
  reason?: string;
}

export interface BrowserSessionStore {
  append(snapshot: BrowserSessionSnapshotV1, event: BrowserSessionEventV1): void;
  load(sessionId: string): BrowserSessionSnapshotV1 | undefined;
  list(limit: number): readonly BrowserSessionSnapshotV1[];
  listEvents(sessionId: string, limit: number): readonly BrowserSessionEventV1[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ADAPTER: BrowserAdapterId = 'browser.local-preview';

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} 必须是安全标识符`);
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function normalizedReason(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 500) throw new Error('reason 不得超过 500 个字符');
  return normalized;
}

function targetFromUrl(raw: string): { host: string; scopeDigest: string } {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('targetUrl 必须是有效 HTTPS URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.includes(':')) {
    throw new Error('浏览目标只允许公网 HTTPS 主机，不允许凭据、本机、IP 或自定义端口');
  }
  const host = parsed.hostname.toLowerCase();
  return { host, scopeDigest: createHash('sha256').update(`${parsed.protocol}//${host}`).digest('hex') };
}

function copySnapshot(value: BrowserSessionSnapshotV1): BrowserSessionSnapshotV1 { return { ...value }; }
function copyEvent(value: BrowserSessionEventV1): BrowserSessionEventV1 { return { ...value }; }

function validateSnapshot(value: BrowserSessionSnapshotV1): void {
  assertIdentifier(value.sessionId, 'sessionId');
  assertIdentifier(value.requestedBy, 'requestedBy');
  assertIdentifier(value.updatedBy, 'updatedBy');
  assertEpoch(value.revision, 'revision');
  assertEpoch(value.createdAt, 'createdAt');
  assertEpoch(value.updatedAt, 'updatedAt');
  if (value.schemaVersion !== BROWSER_SESSION_SCHEMA_VERSION || value.adapterId !== ADAPTER || !DIGEST.test(value.scopeDigest) || !/^[a-z0-9][a-z0-9.-]{1,253}$/.test(value.targetHost)) throw new Error('浏览会话字段无效');
  if (value.canExecute || value.canReadPageContent || value.canReadBrowserSecrets || value.canControlDesktop) throw new Error('首轮浏览会话不得授予执行、页面内容、浏览器秘密或桌面控制');
  normalizedReason(value.reason);
}

function validateEvent(value: BrowserSessionEventV1): void {
  assertIdentifier(value.eventId, 'eventId');
  assertIdentifier(value.sessionId, 'sessionId');
  assertIdentifier(value.by, 'by');
  assertEpoch(value.revision, 'revision');
  assertEpoch(value.at, 'at');
  if (value.schemaVersion !== BROWSER_SESSION_SCHEMA_VERSION || value.canExecute) throw new Error('浏览会话事件不得执行');
  normalizedReason(value.reason);
}

/**
 * 浏览自动化的首轮控制面。它只表示显式授权、暂停、结束和可审查状态，
 * 不创建浏览器、不读取页面、cookie 或 profile，也不允许鼠标键盘或网页动作。
 */
export class BrowserSessionControlPlane {
  constructor(private readonly store: BrowserSessionStore, private readonly makeId: () => string = randomUUID) {}

  create(input: CreateBrowserSessionRequest): BrowserSessionSnapshotV1 {
    assertIdentifier(input.requestedBy, 'requestedBy');
    assertEpoch(input.at, 'at');
    const target = targetFromUrl(input.targetUrl);
    const reason = normalizedReason(input.reason);
    const sessionId = `browser:${this.makeId()}`;
    const snapshot: BrowserSessionSnapshotV1 = {
      schemaVersion: BROWSER_SESSION_SCHEMA_VERSION, sessionId, revision: 1, status: 'requested', adapterId: ADAPTER,
      targetHost: target.host, scopeDigest: target.scopeDigest, requestedBy: input.requestedBy, createdAt: input.at, updatedAt: input.at, updatedBy: input.requestedBy, reason,
      canExecute: false, canReadPageContent: false, canReadBrowserSecrets: false, canControlDesktop: false,
    };
    this.append(snapshot, 'requested', input.requestedBy, input.at, reason);
    return copySnapshot(snapshot);
  }

  authorize(sessionId: string, by: string, at: number, reason?: string): BrowserSessionSnapshotV1 {
    return this.transition(sessionId, 'requested', 'authorized', 'authorized', by, at, reason);
  }

  pause(sessionId: string, by: string, at: number, reason?: string): BrowserSessionSnapshotV1 {
    const current = this.requireSession(sessionId);
    if (current.status !== 'authorized') throw new Error('只有 authorized 浏览会话可以暂停');
    return this.transitionFrom(current, 'paused', 'paused', by, at, reason);
  }

  resume(sessionId: string, by: string, at: number, reason?: string): BrowserSessionSnapshotV1 {
    return this.transition(sessionId, 'paused', 'authorized', 'resumed', by, at, reason);
  }

  end(sessionId: string, by: string, at: number, reason?: string): BrowserSessionSnapshotV1 {
    const current = this.requireSession(sessionId);
    if (current.status === 'ended' || current.status === 'failed') return copySnapshot(current);
    return this.transitionFrom(current, 'ended', 'ended', by, at, reason);
  }

  fail(sessionId: string, by: string, at: number, reason: string): BrowserSessionSnapshotV1 {
    const current = this.requireSession(sessionId);
    if (current.status === 'ended' || current.status === 'failed') throw new Error('终态浏览会话不能再标记失败');
    return this.transitionFrom(current, 'failed', 'failed', by, at, reason);
  }

  list(limit = 100): readonly BrowserSessionSnapshotV1[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('limit 必须是 1-500 的整数');
    return this.store.list(limit).map(copySnapshot);
  }

  events(sessionId: string, limit = 100): readonly BrowserSessionEventV1[] {
    assertIdentifier(sessionId, 'sessionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('limit 必须是 1-500 的整数');
    return this.store.listEvents(sessionId, limit).map(copyEvent);
  }

  private transition(sessionId: string, expected: BrowserSessionStatus, status: BrowserSessionStatus, event: BrowserSessionEventType, by: string, at: number, reason?: string): BrowserSessionSnapshotV1 {
    const current = this.requireSession(sessionId);
    if (current.status !== expected) throw new Error(`浏览会话必须处于 ${expected} 状态`);
    return this.transitionFrom(current, status, event, by, at, reason);
  }

  private transitionFrom(current: BrowserSessionSnapshotV1, status: BrowserSessionStatus, event: BrowserSessionEventType, by: string, at: number, reason?: string): BrowserSessionSnapshotV1 {
    assertIdentifier(by, 'by'); assertEpoch(at, 'at');
    const next: BrowserSessionSnapshotV1 = { ...current, revision: current.revision + 1, status, updatedAt: at, updatedBy: by, reason: normalizedReason(reason) };
    this.append(next, event, by, at, next.reason);
    return copySnapshot(next);
  }

  private append(snapshot: BrowserSessionSnapshotV1, type: BrowserSessionEventType, by: string, at: number, reason?: string): void {
    validateSnapshot(snapshot);
    const event: BrowserSessionEventV1 = { schemaVersion: BROWSER_SESSION_SCHEMA_VERSION, eventId: `browser-event:${this.makeId()}`, sessionId: snapshot.sessionId, revision: snapshot.revision, type, at, by, reason, canExecute: false };
    validateEvent(event); this.store.append(snapshot, event);
  }

  private requireSession(sessionId: string): BrowserSessionSnapshotV1 {
    assertIdentifier(sessionId, 'sessionId');
    const snapshot = this.store.load(sessionId); if (!snapshot) throw new Error(`浏览会话 ${sessionId} 不存在`);
    return snapshot;
  }
}

export class InMemoryBrowserSessionStore implements BrowserSessionStore {
  private readonly snapshots = new Map<string, BrowserSessionSnapshotV1>();
  private readonly audit: BrowserSessionEventV1[] = [];
  append(snapshot: BrowserSessionSnapshotV1, event: BrowserSessionEventV1): void {
    validateSnapshot(snapshot); validateEvent(event);
    const current = this.snapshots.get(snapshot.sessionId);
    if (current && snapshot.revision !== current.revision + 1) throw new Error('浏览会话 revision 必须连续');
    if (!current && snapshot.revision !== 1) throw new Error('浏览会话首个 revision 必须为 1');
    this.snapshots.set(snapshot.sessionId, copySnapshot(snapshot)); this.audit.push(copyEvent(event));
  }
  load(sessionId: string): BrowserSessionSnapshotV1 | undefined { const value = this.snapshots.get(sessionId); return value ? copySnapshot(value) : undefined; }
  list(limit: number): readonly BrowserSessionSnapshotV1[] { return [...this.snapshots.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId)).slice(0, limit).map(copySnapshot); }
  listEvents(sessionId: string, limit: number): readonly BrowserSessionEventV1[] { return this.audit.filter((item) => item.sessionId === sessionId).sort((a, b) => b.revision - a.revision).slice(0, limit).map(copyEvent); }
}

interface SnapshotRow { session_id: string; revision: number; status: BrowserSessionStatus; adapter_id: BrowserAdapterId; target_host: string; scope_digest: string; requested_by: string; created_at: number; updated_at: number; updated_by: string; reason: string | null; }
interface EventRow { event_id: string; session_id: string; revision: number; type: BrowserSessionEventType; at: number; by_actor: string; reason: string | null; }

export class SqliteBrowserSessionStore implements BrowserSessionStore {
  private readonly db: DatabaseSync;
  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true }); this.db = new DatabaseSync(filePath); this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS browser_session_revisions (
      session_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','authorized','paused','ended','failed')),
      adapter_id TEXT NOT NULL CHECK(adapter_id = 'browser.local-preview'), target_host TEXT NOT NULL, scope_digest TEXT NOT NULL, requested_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, reason TEXT, PRIMARY KEY(session_id, revision)
    ); CREATE INDEX IF NOT EXISTS idx_browser_session_latest ON browser_session_revisions(session_id, revision DESC);
    CREATE TABLE IF NOT EXISTS browser_session_events (
      event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('requested','authorized','paused','resumed','ended','failed')),
      at INTEGER NOT NULL, by_actor TEXT NOT NULL, reason TEXT
    ); CREATE INDEX IF NOT EXISTS idx_browser_session_events ON browser_session_events(session_id, revision DESC);`);
  }
  append(snapshot: BrowserSessionSnapshotV1, event: BrowserSessionEventV1): void {
    validateSnapshot(snapshot); validateEvent(event);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`INSERT INTO browser_session_revisions (session_id, revision, status, adapter_id, target_host, scope_digest, requested_by, created_at, updated_at, updated_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshot.sessionId, snapshot.revision, snapshot.status, snapshot.adapterId, snapshot.targetHost, snapshot.scopeDigest, snapshot.requestedBy, snapshot.createdAt, snapshot.updatedAt, snapshot.updatedBy, snapshot.reason ?? null);
      this.db.prepare(`INSERT INTO browser_session_events (event_id, session_id, revision, type, at, by_actor, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(event.eventId, event.sessionId, event.revision, event.type, event.at, event.by, event.reason ?? null);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }
  load(sessionId: string): BrowserSessionSnapshotV1 | undefined {
    const row = this.db.prepare(`SELECT session_id, revision, status, adapter_id, target_host, scope_digest, requested_by, created_at, updated_at, updated_by, reason FROM browser_session_revisions WHERE session_id = ? ORDER BY revision DESC LIMIT 1`).get(sessionId) as unknown as SnapshotRow | undefined;
    return row ? this.snapshot(row) : undefined;
  }
  list(limit: number): readonly BrowserSessionSnapshotV1[] {
    const rows = this.db.prepare(`SELECT r.session_id, r.revision, r.status, r.adapter_id, r.target_host, r.scope_digest, r.requested_by, r.created_at, r.updated_at, r.updated_by, r.reason FROM browser_session_revisions r INNER JOIN (SELECT session_id, MAX(revision) AS latest_revision FROM browser_session_revisions GROUP BY session_id) latest ON latest.session_id = r.session_id AND latest.latest_revision = r.revision ORDER BY r.updated_at DESC, r.session_id DESC LIMIT ?`).all(limit) as unknown as readonly SnapshotRow[];
    return rows.map((row) => this.snapshot(row));
  }
  listEvents(sessionId: string, limit: number): readonly BrowserSessionEventV1[] {
    const rows = this.db.prepare(`SELECT event_id, session_id, revision, type, at, by_actor, reason FROM browser_session_events WHERE session_id = ? ORDER BY revision DESC LIMIT ?`).all(sessionId, limit) as unknown as readonly EventRow[];
    return rows.map((row) => ({ schemaVersion: BROWSER_SESSION_SCHEMA_VERSION, eventId: row.event_id, sessionId: row.session_id, revision: row.revision, type: row.type, at: row.at, by: row.by_actor, reason: row.reason ?? undefined, canExecute: false }));
  }
  close(): void { this.db.close(); }
  private snapshot(row: SnapshotRow): BrowserSessionSnapshotV1 { return { schemaVersion: BROWSER_SESSION_SCHEMA_VERSION, sessionId: row.session_id, revision: row.revision, status: row.status, adapterId: row.adapter_id, targetHost: row.target_host, scopeDigest: row.scope_digest, requestedBy: row.requested_by, createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by, reason: row.reason ?? undefined, canExecute: false, canReadPageContent: false, canReadBrowserSecrets: false, canControlDesktop: false }; }
}
