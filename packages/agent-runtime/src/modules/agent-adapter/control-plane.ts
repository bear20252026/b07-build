import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Capability } from '@awo/protocol';
import type { ExtensionDataBoundary, ExtensionSource } from '../../extension-registry.js';

export type AgentAdapterTransport = 'acp-jsonrpc-stdio' | 'cli-json-lines';
export type AgentAdapterStatus = 'candidate' | 'reviewed' | 'disabled' | 'revoked';
export type AgentAdapterCapability =
  | 'session.new'
  | 'session.load'
  | 'session.resume'
  | 'session.cancel'
  | 'prompt.text'
  | 'prompt.image'
  | 'fs.read'
  | 'fs.write'
  | 'terminal'
  | 'mcp'
  | 'permission.request';
export type AdapterSessionStatus = 'negotiated' | 'bridged' | 'closed' | 'failed';
export type AdapterBridgeMode = 'read-only' | 'approval-required';
export type AdapterMailboxStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface AgentAdapterProtocol {
  transport: AgentAdapterTransport;
  /** 适配器清单可接受的外部协议版本；必须在握手响应中精确协商。 */
  supportedVersions: readonly string[];
  /** 清单允许被协商的 Agent 侧功能，不在此表中的返回能力会被拒绝并审计。 */
  declaredAgentCapabilities: readonly AgentAdapterCapability[];
  /** 仅说明外部 Agent 可能提出的宿主 capability；声明永远不是授予。 */
  requestedHostCapabilities: readonly Capability[];
  independentSessions: true;
}

/**
 * 外部 Agent 的可审计 metadata。connectionRef 只是已经由 Rust Host 或本地运行时登记的引用，不是命令或 URL，
 * 因此登记清单不会自动 spawn、连接或传递环境变量。
 */
export interface AgentAdapterManifestV1 {
  schemaVersion: 1;
  id: string;
  revision: number;
  status: AgentAdapterStatus;
  version: string;
  displayName: string;
  source: Readonly<ExtensionSource>;
  protocol: Readonly<AgentAdapterProtocol>;
  dataBoundary: ExtensionDataBoundary;
  connectionRef: string;
  reviewedBy?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterAgentAdapterRequest {
  id: string;
  version: string;
  displayName: string;
  source: ExtensionSource;
  protocol: AgentAdapterProtocol;
  dataBoundary: ExtensionDataBoundary;
  connectionRef: string;
  note?: string;
  at: number;
}

export interface AgentAdapterManifestStore {
  load(id: string): AgentAdapterManifestV1 | undefined;
  append(manifest: AgentAdapterManifestV1): void;
  history(id: string): readonly AgentAdapterManifestV1[];
  list(): readonly AgentAdapterManifestV1[];
}

export interface AgentAdapterHandshakeRequest {
  adapterId: string;
  /** 宿主拥有的独立会话标识；不会复用外部 Agent 的 sessionId。 */
  adapterSessionId: string;
  parentTaskId: string;
  parentRunId: string;
  agentSessionId: string;
  transport: AgentAdapterTransport;
  protocolVersion: string;
  offeredCapabilities: readonly AgentAdapterCapability[];
  at: number;
}

export interface AgentAdapterSession {
  schemaVersion: 1;
  adapterSessionId: string;
  adapterId: string;
  adapterRevision: number;
  parentTaskId: string;
  parentRunId: string;
  agentSessionId: string;
  transport: AgentAdapterTransport;
  protocolVersion: string;
  acceptedCapabilities: readonly AgentAdapterCapability[];
  rejectedCapabilities: readonly AgentAdapterCapability[];
  status: AdapterSessionStatus;
  bridgeMode?: AdapterBridgeMode;
  revision: number;
  createdAt: number;
  updatedAt: number;
  closeReason?: string;
}

export interface AgentAdapterSessionStore {
  load(adapterSessionId: string): AgentAdapterSession | undefined;
  append(session: AgentAdapterSession): void;
  history(adapterSessionId: string): readonly AgentAdapterSession[];
  listForRun(parentTaskId: string, parentRunId: string): readonly AgentAdapterSession[];
}

export interface OpenAdapterBridgeRequest {
  adapterSessionId: string;
  mode: AdapterBridgeMode;
  at: number;
}

export interface ReadOnlyAdapterIntent {
  schemaVersion: 1;
  adapterSessionId: string;
  adapterId: string;
  parentTaskId: string;
  parentRunId: string;
  intentId: string;
  capability: 'document.parse' | 'model.chat' | 'filesystem.read';
  summary: string;
  canAuthorize: false;
  canExecute: false;
}

export interface AdapterApprovalMailboxItem {
  schemaVersion: 1;
  mailboxId: string;
  revision: number;
  status: AdapterMailboxStatus;
  adapterSessionId: string;
  adapterId: string;
  parentTaskId: string;
  parentRunId: string;
  intentId: string;
  capability: Capability;
  summary: string;
  requestedAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionNote?: string;
  /** 审批记录不授予外部 Agent；真正执行必须再次经过 ControlledToolRunner 与实时 policy。 */
  canAuthorize: false;
  canExecute: false;
}

export interface AdapterApprovalMailboxStore {
  load(mailboxId: string): AdapterApprovalMailboxItem | undefined;
  append(item: AdapterApprovalMailboxItem): void;
  list(parentTaskId?: string, parentRunId?: string): readonly AdapterApprovalMailboxItem[];
  history(mailboxId: string): readonly AdapterApprovalMailboxItem[];
}

export interface ProposeReadOnlyAdapterIntentRequest {
  adapterSessionId: string;
  intentId: string;
  capability: 'document.parse' | 'model.chat' | 'filesystem.read';
  summary: string;
  at: number;
}

export interface ProposeAdapterApprovalRequest {
  mailboxId: string;
  adapterSessionId: string;
  intentId: string;
  capability: Capability;
  summary: string;
  at: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const PROTOCOL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAPABILITIES = new Set<Capability>([
  'document.parse', 'model.chat', 'filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control',
]);
const ADAPTER_CAPABILITIES = new Set<AgentAdapterCapability>([
  'session.new', 'session.load', 'session.resume', 'session.cancel', 'prompt.text', 'prompt.image',
  'fs.read', 'fs.write', 'terminal', 'mcp', 'permission.request',
]);
const READ_ONLY_CAPABILITIES = new Set<ReadOnlyAdapterIntent['capability']>(['document.parse', 'model.chat', 'filesystem.read']);
const DATA_BOUNDARIES = new Set<ExtensionDataBoundary>(['local-only', 'local-preferred', 'external-allowed']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertUnique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} 不得包含重复值`);
}

function assertSource(source: ExtensionSource): void {
  if (!['builtin', 'local-path', 'npm', 'git'].includes(source.type)) throw new Error('source.type 不受支持');
  if (!source.locator.trim() || source.locator.length > 2_048 || /[\r\n\0]/u.test(source.locator)) {
    throw new Error('source.locator 必须是 1-2048 位且不含控制字符');
  }
  if (/^[a-z]+:\/\//iu.test(source.locator)) {
    const parsed = new URL(source.locator);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('source.locator 不得包含凭据、查询参数或片段');
  }
  if (!DIGEST.test(source.digest)) throw new Error('source.digest 必须是 64 位 SHA-256 十六进制摘要');
}

function assertProtocol(protocol: AgentAdapterProtocol): void {
  if (protocol.transport !== 'acp-jsonrpc-stdio' && protocol.transport !== 'cli-json-lines') {
    throw new Error('protocol.transport 必须是 acp-jsonrpc-stdio 或 cli-json-lines');
  }
  if (protocol.independentSessions !== true) throw new Error('外部 Agent adapter 必须声明 independentSessions: true');
  if (protocol.supportedVersions.length === 0 || protocol.supportedVersions.length > 8) {
    throw new Error('protocol.supportedVersions 必须为 1-8 项');
  }
  assertUnique(protocol.supportedVersions, 'protocol.supportedVersions');
  for (const version of protocol.supportedVersions) {
    if (!PROTOCOL_VERSION.test(version)) throw new Error('protocol.supportedVersions 包含无效版本标识');
  }
  assertUnique(protocol.declaredAgentCapabilities, 'protocol.declaredAgentCapabilities');
  for (const capability of protocol.declaredAgentCapabilities) {
    if (!ADAPTER_CAPABILITIES.has(capability)) throw new Error(`protocol.declaredAgentCapabilities 包含未支持能力：${capability}`);
  }
  assertUnique(protocol.requestedHostCapabilities, 'protocol.requestedHostCapabilities');
  for (const capability of protocol.requestedHostCapabilities) {
    if (!CAPABILITIES.has(capability)) throw new Error(`protocol.requestedHostCapabilities 包含未声明 capability：${capability}`);
  }
}

function assertManifestRequest(request: RegisterAgentAdapterRequest): void {
  assertIdentifier(request.id, 'id');
  if (!SEMVER.test(request.version)) throw new Error('version 必须是显式 semver');
  if (!request.displayName.trim() || request.displayName.trim().length > 160) throw new Error('displayName 必须是 1-160 位文本');
  assertSource(request.source);
  assertProtocol(request.protocol);
  if (!DATA_BOUNDARIES.has(request.dataBoundary)) throw new Error('dataBoundary 不受支持');
  if (!request.connectionRef.trim() || request.connectionRef.length > 256 || /[\r\n\0]/u.test(request.connectionRef)) {
    throw new Error('connectionRef 必须是 1-256 位安全引用，不得携带命令、URL 或控制字符');
  }
  if (/[/\\]/u.test(request.connectionRef)) throw new Error('connectionRef 必须是注册引用，不能包含路径分隔符');
  if (request.note !== undefined && request.note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
  assertEpoch(request.at, 'at');
}

function copySource(source: ExtensionSource): ExtensionSource {
  return { ...source };
}

function copyProtocol(protocol: AgentAdapterProtocol): AgentAdapterProtocol {
  return {
    ...protocol,
    supportedVersions: [...protocol.supportedVersions],
    declaredAgentCapabilities: [...protocol.declaredAgentCapabilities],
    requestedHostCapabilities: [...protocol.requestedHostCapabilities],
  };
}

export function copyAgentAdapterManifest(manifest: AgentAdapterManifestV1): AgentAdapterManifestV1 {
  return { ...manifest, source: copySource(manifest.source), protocol: copyProtocol(manifest.protocol) };
}

function copySession(session: AgentAdapterSession): AgentAdapterSession {
  return { ...session, acceptedCapabilities: [...session.acceptedCapabilities], rejectedCapabilities: [...session.rejectedCapabilities] };
}

function copyMailbox(item: AdapterApprovalMailboxItem): AdapterApprovalMailboxItem {
  return { ...item };
}

function requireTransition(current: AgentAdapterStatus, next: AgentAdapterStatus): void {
  const transitions: Readonly<Record<AgentAdapterStatus, readonly AgentAdapterStatus[]>> = {
    candidate: ['reviewed', 'disabled', 'revoked'],
    reviewed: ['disabled', 'revoked'],
    disabled: ['reviewed', 'revoked'],
    revoked: [],
  };
  if (!transitions[current].includes(next)) throw new Error(`Agent Adapter 状态不能从 ${current} 转为 ${next}`);
}

function assertMailboxTransition(current: AdapterMailboxStatus, next: AdapterMailboxStatus): void {
  const transitions: Readonly<Record<AdapterMailboxStatus, readonly AdapterMailboxStatus[]>> = {
    pending: ['approved', 'denied', 'expired'],
    approved: [], denied: [], expired: [],
  };
  if (!transitions[current].includes(next)) throw new Error(`审批邮箱状态不能从 ${current} 转为 ${next}`);
}

export class InMemoryAgentAdapterManifestStore implements AgentAdapterManifestStore {
  private readonly revisions = new Map<string, AgentAdapterManifestV1[]>();

  load(id: string): AgentAdapterManifestV1 | undefined {
    const current = this.revisions.get(id)?.at(-1);
    return current ? copyAgentAdapterManifest(current) : undefined;
  }

  append(manifest: AgentAdapterManifestV1): void {
    const history = this.revisions.get(manifest.id) ?? [];
    const current = history.at(-1);
    if (!current && manifest.revision !== 1) throw new Error('新 Agent Adapter manifest revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('Agent Adapter manifest revision 必须连续递增');
    this.revisions.set(manifest.id, [...history, copyAgentAdapterManifest(manifest)]);
  }

  history(id: string): readonly AgentAdapterManifestV1[] {
    return (this.revisions.get(id) ?? []).map(copyAgentAdapterManifest);
  }

  list(): readonly AgentAdapterManifestV1[] {
    return [...this.revisions.values()]
      .map((history) => history.at(-1))
      .filter((value): value is AgentAdapterManifestV1 => Boolean(value))
      .map(copyAgentAdapterManifest)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }
}

interface ManifestRow { manifest_json: string; }

/** 追加式 Adapter manifest SQLite 账本；它不存命令行、环境变量、认证内容或外部会话全文。 */
export class SqliteAgentAdapterManifestStore implements AgentAdapterManifestStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_adapter_manifest_revisions (
        adapter_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        PRIMARY KEY (adapter_id, revision)
      );
    `);
  }

  load(id: string): AgentAdapterManifestV1 | undefined {
    assertIdentifier(id, 'id');
    const row = this.db.prepare(`SELECT manifest_json FROM agent_adapter_manifest_revisions WHERE adapter_id = ? ORDER BY revision DESC LIMIT 1`).get(id) as ManifestRow | undefined;
    return row ? copyAgentAdapterManifest(JSON.parse(row.manifest_json) as AgentAdapterManifestV1) : undefined;
  }

  append(manifest: AgentAdapterManifestV1): void {
    const current = this.load(manifest.id);
    if (!current && manifest.revision !== 1) throw new Error('新 Agent Adapter manifest revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('Agent Adapter manifest revision 必须连续递增');
    this.db.prepare(`INSERT INTO agent_adapter_manifest_revisions (adapter_id, revision, manifest_json) VALUES (?, ?, ?)`)
      .run(manifest.id, manifest.revision, JSON.stringify(copyAgentAdapterManifest(manifest)));
  }

  history(id: string): readonly AgentAdapterManifestV1[] {
    assertIdentifier(id, 'id');
    const rows = this.db.prepare(`SELECT manifest_json FROM agent_adapter_manifest_revisions WHERE adapter_id = ? ORDER BY revision ASC`).all(id) as unknown as readonly ManifestRow[];
    return rows.map((row) => copyAgentAdapterManifest(JSON.parse(row.manifest_json) as AgentAdapterManifestV1));
  }

  list(): readonly AgentAdapterManifestV1[] {
    const rows = this.db.prepare(`
      SELECT r.manifest_json FROM agent_adapter_manifest_revisions r
      INNER JOIN (SELECT adapter_id, MAX(revision) AS revision FROM agent_adapter_manifest_revisions GROUP BY adapter_id) latest
        ON latest.adapter_id = r.adapter_id AND latest.revision = r.revision
    `).all() as unknown as readonly ManifestRow[];
    return rows.map((row) => copyAgentAdapterManifest(JSON.parse(row.manifest_json) as AgentAdapterManifestV1))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  close(): void { this.db.close(); }
}

export class InMemoryAgentAdapterSessionStore implements AgentAdapterSessionStore {
  private readonly revisions = new Map<string, AgentAdapterSession[]>();

  load(adapterSessionId: string): AgentAdapterSession | undefined {
    const current = this.revisions.get(adapterSessionId)?.at(-1);
    return current ? copySession(current) : undefined;
  }

  append(session: AgentAdapterSession): void {
    const history = this.revisions.get(session.adapterSessionId) ?? [];
    const current = history.at(-1);
    if (!current && session.revision !== 1) throw new Error('新 Adapter session revision 必须为 1');
    if (current && session.revision !== current.revision + 1) throw new Error('Adapter session revision 必须连续递增');
    this.revisions.set(session.adapterSessionId, [...history, copySession(session)]);
  }

  history(adapterSessionId: string): readonly AgentAdapterSession[] {
    return (this.revisions.get(adapterSessionId) ?? []).map(copySession);
  }

  listForRun(parentTaskId: string, parentRunId: string): readonly AgentAdapterSession[] {
    return [...this.revisions.values()]
      .map((history) => history.at(-1))
      .filter((value): value is AgentAdapterSession => value !== undefined)
      .filter((value) => value.parentTaskId === parentTaskId && value.parentRunId === parentRunId)
      .map(copySession)
      .sort((left, right) => left.createdAt - right.createdAt || left.adapterSessionId.localeCompare(right.adapterSessionId));
  }
}

interface SessionRow { session_json: string; }

/** 仅保存 host session metadata 和协商能力，不保存外部 Agent 对话全文或工具输出。 */
export class SqliteAgentAdapterSessionStore implements AgentAdapterSessionStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_adapter_session_revisions (
        adapter_session_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        session_json TEXT NOT NULL,
        PRIMARY KEY (adapter_session_id, revision)
      );
    `);
  }

  load(adapterSessionId: string): AgentAdapterSession | undefined {
    assertIdentifier(adapterSessionId, 'adapterSessionId');
    const row = this.db.prepare(`SELECT session_json FROM agent_adapter_session_revisions WHERE adapter_session_id = ? ORDER BY revision DESC LIMIT 1`).get(adapterSessionId) as SessionRow | undefined;
    return row ? copySession(JSON.parse(row.session_json) as AgentAdapterSession) : undefined;
  }

  append(session: AgentAdapterSession): void {
    const current = this.load(session.adapterSessionId);
    if (!current && session.revision !== 1) throw new Error('新 Adapter session revision 必须为 1');
    if (current && session.revision !== current.revision + 1) throw new Error('Adapter session revision 必须连续递增');
    this.db.prepare(`INSERT INTO agent_adapter_session_revisions (adapter_session_id, revision, session_json) VALUES (?, ?, ?)`)
      .run(session.adapterSessionId, session.revision, JSON.stringify(copySession(session)));
  }

  history(adapterSessionId: string): readonly AgentAdapterSession[] {
    assertIdentifier(adapterSessionId, 'adapterSessionId');
    const rows = this.db.prepare(`SELECT session_json FROM agent_adapter_session_revisions WHERE adapter_session_id = ? ORDER BY revision ASC`).all(adapterSessionId) as unknown as readonly SessionRow[];
    return rows.map((row) => copySession(JSON.parse(row.session_json) as AgentAdapterSession));
  }

  listForRun(parentTaskId: string, parentRunId: string): readonly AgentAdapterSession[] {
    assertIdentifier(parentTaskId, 'parentTaskId');
    assertIdentifier(parentRunId, 'parentRunId');
    const rows = this.db.prepare(`
      SELECT r.session_json FROM agent_adapter_session_revisions r
      INNER JOIN (SELECT adapter_session_id, MAX(revision) AS revision FROM agent_adapter_session_revisions GROUP BY adapter_session_id) latest
        ON latest.adapter_session_id = r.adapter_session_id AND latest.revision = r.revision
    `).all() as unknown as readonly SessionRow[];
    return rows.map((row) => copySession(JSON.parse(row.session_json) as AgentAdapterSession))
      .filter((session) => session.parentTaskId === parentTaskId && session.parentRunId === parentRunId)
      .sort((left, right) => left.createdAt - right.createdAt || left.adapterSessionId.localeCompare(right.adapterSessionId));
  }

  close(): void { this.db.close(); }
}

export class InMemoryAdapterApprovalMailboxStore implements AdapterApprovalMailboxStore {
  private readonly revisions = new Map<string, AdapterApprovalMailboxItem[]>();

  load(mailboxId: string): AdapterApprovalMailboxItem | undefined {
    const current = this.revisions.get(mailboxId)?.at(-1);
    return current ? copyMailbox(current) : undefined;
  }

  append(item: AdapterApprovalMailboxItem): void {
    const history = this.revisions.get(item.mailboxId) ?? [];
    const current = history.at(-1);
    if (!current && item.revision !== 1) throw new Error('新 Adapter mailbox revision 必须为 1');
    if (current && item.revision !== current.revision + 1) throw new Error('Adapter mailbox revision 必须连续递增');
    this.revisions.set(item.mailboxId, [...history, copyMailbox(item)]);
  }

  list(parentTaskId?: string, parentRunId?: string): readonly AdapterApprovalMailboxItem[] {
    return [...this.revisions.values()]
      .map((history) => history.at(-1))
      .filter((value): value is AdapterApprovalMailboxItem => value !== undefined)
      .filter((value) => (!parentTaskId || value.parentTaskId === parentTaskId) && (!parentRunId || value.parentRunId === parentRunId))
      .map(copyMailbox)
      .sort((left, right) => left.requestedAt - right.requestedAt || left.mailboxId.localeCompare(right.mailboxId));
  }

  history(mailboxId: string): readonly AdapterApprovalMailboxItem[] {
    return (this.revisions.get(mailboxId) ?? []).map(copyMailbox);
  }
}

interface MailboxRow { mailbox_json: string; }

/** 审批邮箱只保存结构化 capability 意图和人工决定，不保存命令、文件正文、密钥或外部 Agent transcript。 */
export class SqliteAdapterApprovalMailboxStore implements AdapterApprovalMailboxStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_adapter_mailbox_revisions (
        mailbox_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        mailbox_json TEXT NOT NULL,
        PRIMARY KEY (mailbox_id, revision)
      );
    `);
  }

  load(mailboxId: string): AdapterApprovalMailboxItem | undefined {
    assertIdentifier(mailboxId, 'mailboxId');
    const row = this.db.prepare(`SELECT mailbox_json FROM agent_adapter_mailbox_revisions WHERE mailbox_id = ? ORDER BY revision DESC LIMIT 1`).get(mailboxId) as MailboxRow | undefined;
    return row ? copyMailbox(JSON.parse(row.mailbox_json) as AdapterApprovalMailboxItem) : undefined;
  }

  append(item: AdapterApprovalMailboxItem): void {
    const current = this.load(item.mailboxId);
    if (!current && item.revision !== 1) throw new Error('新 Adapter mailbox revision 必须为 1');
    if (current && item.revision !== current.revision + 1) throw new Error('Adapter mailbox revision 必须连续递增');
    this.db.prepare(`INSERT INTO agent_adapter_mailbox_revisions (mailbox_id, revision, mailbox_json) VALUES (?, ?, ?)`)
      .run(item.mailboxId, item.revision, JSON.stringify(copyMailbox(item)));
  }

  list(parentTaskId?: string, parentRunId?: string): readonly AdapterApprovalMailboxItem[] {
    const rows = this.db.prepare(`
      SELECT r.mailbox_json FROM agent_adapter_mailbox_revisions r
      INNER JOIN (SELECT mailbox_id, MAX(revision) AS revision FROM agent_adapter_mailbox_revisions GROUP BY mailbox_id) latest
        ON latest.mailbox_id = r.mailbox_id AND latest.revision = r.revision
    `).all() as unknown as readonly MailboxRow[];
    return rows.map((row) => copyMailbox(JSON.parse(row.mailbox_json) as AdapterApprovalMailboxItem))
      .filter((item) => (!parentTaskId || item.parentTaskId === parentTaskId) && (!parentRunId || item.parentRunId === parentRunId))
      .sort((left, right) => left.requestedAt - right.requestedAt || left.mailboxId.localeCompare(right.mailboxId));
  }

  history(mailboxId: string): readonly AdapterApprovalMailboxItem[] {
    assertIdentifier(mailboxId, 'mailboxId');
    const rows = this.db.prepare(`SELECT mailbox_json FROM agent_adapter_mailbox_revisions WHERE mailbox_id = ? ORDER BY revision ASC`).all(mailboxId) as unknown as readonly MailboxRow[];
    return rows.map((row) => copyMailbox(JSON.parse(row.mailbox_json) as AdapterApprovalMailboxItem));
  }

  close(): void { this.db.close(); }
}

/**
 * 受控外部 Agent 协商与桥接服务。它接收已由 Rust Host 或本地 runner 获得的握手 metadata，
 * 只记录协议/会话/意图，不创建子进程、不向外发送 JSON-RPC、不执行文件、终端或浏览器操作。
 */
export class AgentAdapterControlPlane {
  constructor(
    private readonly manifests: AgentAdapterManifestStore,
    private readonly sessions: AgentAdapterSessionStore,
    private readonly mailbox: AdapterApprovalMailboxStore,
  ) {}

  registerCandidate(request: RegisterAgentAdapterRequest): AgentAdapterManifestV1 {
    assertManifestRequest(request);
    if (this.manifests.load(request.id)) throw new Error(`Agent Adapter ${request.id} 已存在`);
    const manifest: AgentAdapterManifestV1 = {
      schemaVersion: 1,
      id: request.id,
      revision: 1,
      status: 'candidate',
      version: request.version,
      displayName: request.displayName.trim(),
      source: copySource(request.source),
      protocol: copyProtocol(request.protocol),
      dataBoundary: request.dataBoundary,
      connectionRef: request.connectionRef,
      note: request.note?.trim() || undefined,
      createdAt: request.at,
      updatedAt: request.at,
    };
    this.manifests.append(manifest);
    return copyAgentAdapterManifest(manifest);
  }

  review(id: string, verifiedDigest: string, reviewedBy: string, at: number, note?: string): AgentAdapterManifestV1 {
    assertIdentifier(id, 'id');
    if (!DIGEST.test(verifiedDigest)) throw new Error('verifiedDigest 必须是 64 位 SHA-256 十六进制摘要');
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    const current = this.requireManifest(id);
    if (current.source.digest.toLocaleLowerCase() !== verifiedDigest.toLocaleLowerCase()) throw new Error('Agent Adapter source digest 不一致');
    return this.transition(current, 'reviewed', reviewedBy, at, note);
  }

  disable(id: string, reviewedBy: string, at: number, note?: string): AgentAdapterManifestV1 {
    assertIdentifier(reviewedBy, 'reviewedBy');
    return this.transition(this.requireManifest(id), 'disabled', reviewedBy, at, note);
  }

  revoke(id: string, reviewedBy: string, at: number, note?: string): AgentAdapterManifestV1 {
    assertIdentifier(reviewedBy, 'reviewedBy');
    return this.transition(this.requireManifest(id), 'revoked', reviewedBy, at, note);
  }

  negotiate(request: AgentAdapterHandshakeRequest): AgentAdapterSession {
    assertIdentifier(request.adapterId, 'adapterId');
    assertIdentifier(request.adapterSessionId, 'adapterSessionId');
    assertIdentifier(request.parentTaskId, 'parentTaskId');
    assertIdentifier(request.parentRunId, 'parentRunId');
    assertIdentifier(request.agentSessionId, 'agentSessionId');
    assertEpoch(request.at, 'at');
    if (this.sessions.load(request.adapterSessionId)) throw new Error(`Adapter session ${request.adapterSessionId} 已存在`);
    const manifest = this.requireManifest(request.adapterId);
    if (manifest.status !== 'reviewed') throw new Error(`Agent Adapter ${request.adapterId} 未处于 reviewed 状态，不能建立外部 session`);
    if (manifest.protocol.transport !== request.transport) throw new Error('握手 transport 与已审查 manifest 不一致');
    if (!manifest.protocol.supportedVersions.includes(request.protocolVersion)) throw new Error('握手 protocolVersion 不在已审查兼容范围内');
    assertUnique(request.offeredCapabilities, 'offeredCapabilities');
    for (const capability of request.offeredCapabilities) {
      if (!ADAPTER_CAPABILITIES.has(capability)) throw new Error(`握手包含未支持 Agent capability：${capability}`);
    }
    const acceptedCapabilities = request.offeredCapabilities.filter((capability) => manifest.protocol.declaredAgentCapabilities.includes(capability));
    const rejectedCapabilities = request.offeredCapabilities.filter((capability) => !manifest.protocol.declaredAgentCapabilities.includes(capability));
    const session: AgentAdapterSession = {
      schemaVersion: 1,
      adapterSessionId: request.adapterSessionId,
      adapterId: manifest.id,
      adapterRevision: manifest.revision,
      parentTaskId: request.parentTaskId,
      parentRunId: request.parentRunId,
      agentSessionId: request.agentSessionId,
      transport: request.transport,
      protocolVersion: request.protocolVersion,
      acceptedCapabilities,
      rejectedCapabilities,
      status: 'negotiated',
      revision: 1,
      createdAt: request.at,
      updatedAt: request.at,
    };
    this.sessions.append(session);
    return copySession(session);
  }

  openBridge(request: OpenAdapterBridgeRequest): AgentAdapterSession {
    assertIdentifier(request.adapterSessionId, 'adapterSessionId');
    assertEpoch(request.at, 'at');
    const current = this.requireSession(request.adapterSessionId);
    this.assertManifestCurrent(current);
    if (current.status !== 'negotiated') throw new Error('只有已协商的独立 Adapter session 能打开任务桥');
    const next: AgentAdapterSession = {
      ...current,
      acceptedCapabilities: [...current.acceptedCapabilities],
      rejectedCapabilities: [...current.rejectedCapabilities],
      status: 'bridged',
      bridgeMode: request.mode,
      revision: current.revision + 1,
      updatedAt: request.at,
    };
    this.sessions.append(next);
    return copySession(next);
  }

  closeSession(adapterSessionId: string, at: number, reason?: string): AgentAdapterSession {
    assertIdentifier(adapterSessionId, 'adapterSessionId');
    assertEpoch(at, 'at');
    const current = this.requireSession(adapterSessionId);
    if (current.status === 'closed') return current;
    const next: AgentAdapterSession = {
      ...current,
      acceptedCapabilities: [...current.acceptedCapabilities],
      rejectedCapabilities: [...current.rejectedCapabilities],
      status: 'closed', revision: current.revision + 1, updatedAt: at,
      closeReason: reason?.trim().slice(0, 500) || undefined,
    };
    this.sessions.append(next);
    return copySession(next);
  }

  proposeReadOnlyIntent(request: ProposeReadOnlyAdapterIntentRequest): ReadOnlyAdapterIntent {
    assertIdentifier(request.intentId, 'intentId');
    assertEpoch(request.at, 'at');
    if (!READ_ONLY_CAPABILITIES.has(request.capability)) throw new Error('只读桥只允许 document.parse、model.chat 或 filesystem.read');
    if (!request.summary.trim() || request.summary.trim().length > 1_000) throw new Error('summary 必须是 1-1000 位文本');
    const session = this.requireBridgedSession(request.adapterSessionId, 'read-only');
    return {
      schemaVersion: 1,
      adapterSessionId: session.adapterSessionId,
      adapterId: session.adapterId,
      parentTaskId: session.parentTaskId,
      parentRunId: session.parentRunId,
      intentId: request.intentId,
      capability: request.capability,
      summary: request.summary.trim(),
      canAuthorize: false,
      canExecute: false,
    };
  }

  proposeApproval(request: ProposeAdapterApprovalRequest): AdapterApprovalMailboxItem {
    assertIdentifier(request.mailboxId, 'mailboxId');
    assertIdentifier(request.intentId, 'intentId');
    assertEpoch(request.at, 'at');
    if (!CAPABILITIES.has(request.capability)) throw new Error(`capability 未声明：${request.capability}`);
    if (!request.summary.trim() || request.summary.trim().length > 1_000) throw new Error('summary 必须是 1-1000 位文本');
    if (this.mailbox.load(request.mailboxId)) throw new Error(`审批邮箱项目 ${request.mailboxId} 已存在`);
    const session = this.requireBridgedSession(request.adapterSessionId, 'approval-required');
    const item: AdapterApprovalMailboxItem = {
      schemaVersion: 1,
      mailboxId: request.mailboxId,
      revision: 1,
      status: 'pending',
      adapterSessionId: session.adapterSessionId,
      adapterId: session.adapterId,
      parentTaskId: session.parentTaskId,
      parentRunId: session.parentRunId,
      intentId: request.intentId,
      capability: request.capability,
      summary: request.summary.trim(),
      requestedAt: request.at,
      canAuthorize: false,
      canExecute: false,
    };
    this.mailbox.append(item);
    return copyMailbox(item);
  }

  approveMailbox(mailboxId: string, reviewedBy: string, at: number, note?: string): AdapterApprovalMailboxItem {
    return this.resolveMailbox(mailboxId, 'approved', reviewedBy, at, note);
  }

  denyMailbox(mailboxId: string, reviewedBy: string, at: number, note?: string): AdapterApprovalMailboxItem {
    return this.resolveMailbox(mailboxId, 'denied', reviewedBy, at, note);
  }

  expireMailbox(mailboxId: string, at: number, note?: string): AdapterApprovalMailboxItem {
    return this.resolveMailbox(mailboxId, 'expired', 'system-expiry', at, note);
  }

  getManifest(id: string): AgentAdapterManifestV1 | undefined {
    assertIdentifier(id, 'id');
    const manifest = this.manifests.load(id);
    return manifest ? copyAgentAdapterManifest(manifest) : undefined;
  }

  listManifests(): readonly AgentAdapterManifestV1[] {
    return this.manifests.list().map(copyAgentAdapterManifest);
  }

  listSessions(parentTaskId: string, parentRunId: string): readonly AgentAdapterSession[] {
    assertIdentifier(parentTaskId, 'parentTaskId');
    assertIdentifier(parentRunId, 'parentRunId');
    return this.sessions.listForRun(parentTaskId, parentRunId).map(copySession);
  }

  listMailbox(parentTaskId?: string, parentRunId?: string): readonly AdapterApprovalMailboxItem[] {
    if (parentTaskId !== undefined) assertIdentifier(parentTaskId, 'parentTaskId');
    if (parentRunId !== undefined) assertIdentifier(parentRunId, 'parentRunId');
    return this.mailbox.list(parentTaskId, parentRunId).map(copyMailbox);
  }

  private transition(current: AgentAdapterManifestV1, status: AgentAdapterStatus, reviewedBy: string, at: number, note?: string): AgentAdapterManifestV1 {
    assertEpoch(at, 'at');
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
    requireTransition(current.status, status);
    const next: AgentAdapterManifestV1 = {
      ...current,
      source: copySource(current.source),
      protocol: copyProtocol(current.protocol),
      revision: current.revision + 1,
      status,
      reviewedBy,
      note: note?.trim() || current.note,
      updatedAt: at,
    };
    this.manifests.append(next);
    return copyAgentAdapterManifest(next);
  }

  private resolveMailbox(mailboxId: string, status: Extract<AdapterMailboxStatus, 'approved' | 'denied' | 'expired'>, reviewedBy: string, at: number, note?: string): AdapterApprovalMailboxItem {
    assertIdentifier(mailboxId, 'mailboxId');
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
    const current = this.mailbox.load(mailboxId);
    if (!current) throw new Error(`审批邮箱项目 ${mailboxId} 不存在`);
    assertMailboxTransition(current.status, status);
    const session = this.requireSession(current.adapterSessionId);
    this.assertManifestCurrent(session);
    const next: AdapterApprovalMailboxItem = {
      ...current,
      revision: current.revision + 1,
      status,
      resolvedAt: at,
      resolvedBy: reviewedBy,
      resolutionNote: note?.trim() || undefined,
      canAuthorize: false,
      canExecute: false,
    };
    this.mailbox.append(next);
    return copyMailbox(next);
  }

  private requireBridgedSession(adapterSessionId: string, mode: AdapterBridgeMode): AgentAdapterSession {
    assertIdentifier(adapterSessionId, 'adapterSessionId');
    const session = this.requireSession(adapterSessionId);
    this.assertManifestCurrent(session);
    if (session.status !== 'bridged' || session.bridgeMode !== mode) throw new Error(`Adapter session 未处于 ${mode} 任务桥状态`);
    return session;
  }

  private assertManifestCurrent(session: AgentAdapterSession): void {
    const manifest = this.requireManifest(session.adapterId);
    if (manifest.status !== 'reviewed' || manifest.revision !== session.adapterRevision) {
      throw new Error(`Agent Adapter ${session.adapterId} 已停用、撤销或更新；不得继续桥接外部会话`);
    }
  }

  private requireManifest(id: string): AgentAdapterManifestV1 {
    assertIdentifier(id, 'id');
    const manifest = this.manifests.load(id);
    if (!manifest) throw new Error(`Agent Adapter ${id} 不存在`);
    return manifest;
  }

  private requireSession(adapterSessionId: string): AgentAdapterSession {
    assertIdentifier(adapterSessionId, 'adapterSessionId');
    const session = this.sessions.load(adapterSessionId);
    if (!session) throw new Error(`Adapter session ${adapterSessionId} 不存在`);
    return session;
  }
}
