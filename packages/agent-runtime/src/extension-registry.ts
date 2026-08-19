import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Capability } from '@awo/protocol';

export const EXTENSION_API_VERSION = 'awo.extension.v1' as const;

export type ExtensionKind =
  | 'model-provider'
  | 'knowledge-importer'
  | 'tool-adapter'
  | 'skill-pack'
  | 'agent-harness'
  | 'agent-adapter'
  | 'ui-panel'
  | 'scheduler-adapter'
  | 'media-worker';

export type ExtensionSourceType = 'builtin' | 'local-path' | 'npm' | 'git';
export type ExtensionDataBoundary = 'local-only' | 'local-preferred' | 'external-allowed';
export type ExtensionExecutionMode = 'in-process' | 'supervised-process' | 'remote-protocol';
export type ExtensionStatus = 'discovered' | 'reviewed' | 'installed' | 'disabled' | 'revoked';

export interface ExtensionSource {
  type: ExtensionSourceType;
  /** 仅为可审查定位信息；不得包含用户名、密码、查询参数或片段。 */
  locator: string;
  /** 已审查制品的 SHA-256 十六进制摘要。 */
  digest: string;
}

export interface ExtensionCompatibility {
  /** 当前 host API 兼容范围；v0.15 采用显式精确版本，拒绝隐式协商。 */
  hostApiVersion: typeof EXTENSION_API_VERSION;
  /** 扩展可消费的已版本化通道，例如 awo.task-event.v1。 */
  protocols: readonly string[];
}

export interface ExtensionResourceBudget {
  maxMemoryMb: number;
  maxCpuMs: number;
  maxStartupMs: number;
}

export interface ExtensionEntry {
  mode: ExtensionExecutionMode;
  /** 仅元数据引用；ExtensionRegistry 不会 import、spawn 或连接该入口。 */
  ref: string;
}

export interface ExtensionManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  apiVersion: typeof EXTENSION_API_VERSION;
  kind: ExtensionKind;
  displayName: string;
  source: Readonly<ExtensionSource>;
  compatibility: Readonly<ExtensionCompatibility>;
  declaredCapabilities: readonly Capability[];
  requestedPermissions: readonly Capability[];
  dataBoundary: ExtensionDataBoundary;
  resourceBudget: Readonly<ExtensionResourceBudget>;
  entry?: Readonly<ExtensionEntry>;
  status: ExtensionStatus;
  revision: number;
  discoveredAt: number;
  updatedAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
  installedAt?: number;
  disabledAt?: number;
  revokedAt?: number;
  note?: string;
}

export interface DiscoverExtensionRequest {
  id: string;
  version: string;
  kind: ExtensionKind;
  displayName: string;
  source: ExtensionSource;
  compatibility: ExtensionCompatibility;
  declaredCapabilities: readonly Capability[];
  requestedPermissions: readonly Capability[];
  dataBoundary: ExtensionDataBoundary;
  resourceBudget: ExtensionResourceBudget;
  entry?: ExtensionEntry;
  note?: string;
  at: number;
}

export interface ExtensionManifestStore {
  load(id: string): ExtensionManifest | undefined;
  append(manifest: ExtensionManifest): void;
  list(): readonly ExtensionManifest[];
  history(id: string): readonly ExtensionManifest[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PROTOCOL = /^[a-z][a-z0-9.-]{0,63}\.v[1-9][0-9]*$/;
const DECISIVE_STATUSES = new Set<ExtensionStatus>(['installed', 'disabled', 'revoked']);
const KINDS = new Set<ExtensionKind>([
  'model-provider', 'knowledge-importer', 'tool-adapter', 'skill-pack', 'agent-harness',
  'agent-adapter', 'ui-panel', 'scheduler-adapter', 'media-worker',
]);
const SOURCE_TYPES = new Set<ExtensionSourceType>(['builtin', 'local-path', 'npm', 'git']);
const DATA_BOUNDARIES = new Set<ExtensionDataBoundary>(['local-only', 'local-preferred', 'external-allowed']);
const EXECUTION_MODES = new Set<ExtensionExecutionMode>(['in-process', 'supervised-process', 'remote-protocol']);
const CAPABILITIES = new Set<Capability>([
  'document.parse', 'model.chat', 'filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control',
]);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正安全整数`);
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} 必须是 SHA-256 十六进制摘要`);
}

function assertSafeLocator(value: string): void {
  if (!value.trim() || value.length > 2_048 || /[\r\n\0]/u.test(value)) throw new Error('source.locator 必须为 1-2048 字符且不含控制字符');
  if (/^[a-z]+:\/\//iu.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('source.locator URL 无效');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('source.locator URL 不得携带凭据、查询参数或片段');
  }
}

function assertUniqueCapabilities(values: readonly Capability[], label: string): void {
  const seen = new Set<Capability>();
  for (const value of values) {
    if (!CAPABILITIES.has(value)) throw new Error(`${label} 包含未声明 capability：${value}`);
    if (seen.has(value)) throw new Error(`${label} 不得包含重复 capability：${value}`);
    seen.add(value);
  }
}

function assertManifestRequest(request: DiscoverExtensionRequest): void {
  assertIdentifier(request.id, 'id');
  if (!SEMVER.test(request.version)) throw new Error('version 必须是显式 semver');
  if (!KINDS.has(request.kind)) throw new Error('kind 未被支持');
  if (!request.displayName.trim() || request.displayName.length > 160) throw new Error('displayName 必须是 1-160 字符');
  if (!SOURCE_TYPES.has(request.source.type)) throw new Error('source.type 未被支持');
  assertSafeLocator(request.source.locator);
  assertDigest(request.source.digest, 'source.digest');
  if (request.compatibility.hostApiVersion !== EXTENSION_API_VERSION) throw new Error(`compatibility.hostApiVersion 必须是 ${EXTENSION_API_VERSION}`);
  if (request.compatibility.protocols.length > 16) throw new Error('compatibility.protocols 最多 16 项');
  const protocols = new Set<string>();
  for (const protocol of request.compatibility.protocols) {
    if (!PROTOCOL.test(protocol) || protocols.has(protocol)) throw new Error('compatibility.protocols 必须是唯一的已版本化协议标识');
    protocols.add(protocol);
  }
  assertUniqueCapabilities(request.declaredCapabilities, 'declaredCapabilities');
  assertUniqueCapabilities(request.requestedPermissions, 'requestedPermissions');
  for (const requested of request.requestedPermissions) {
    if (!request.declaredCapabilities.includes(requested)) throw new Error('requestedPermissions 必须是 declaredCapabilities 的子集');
  }
  if (!DATA_BOUNDARIES.has(request.dataBoundary)) throw new Error('dataBoundary 未被支持');
  assertPositiveInteger(request.resourceBudget.maxMemoryMb, 'resourceBudget.maxMemoryMb');
  assertPositiveInteger(request.resourceBudget.maxCpuMs, 'resourceBudget.maxCpuMs');
  assertPositiveInteger(request.resourceBudget.maxStartupMs, 'resourceBudget.maxStartupMs');
  if (request.entry) {
    if (!EXECUTION_MODES.has(request.entry.mode)) throw new Error('entry.mode 未被支持');
    if (!request.entry.ref.trim() || request.entry.ref.length > 1_024 || /[\r\n\0]/u.test(request.entry.ref)) {
      throw new Error('entry.ref 必须是 1-1024 字符且不含控制字符');
    }
  }
  if (request.note !== undefined && request.note.length > 2_000) throw new Error('note 不得超过 2000 字符');
  assertEpoch(request.at, 'at');
}

function copySource(source: ExtensionSource): ExtensionSource {
  return { ...source };
}

function copyManifest(manifest: ExtensionManifest): ExtensionManifest {
  return {
    ...manifest,
    source: copySource(manifest.source),
    compatibility: { ...manifest.compatibility, protocols: [...manifest.compatibility.protocols] },
    declaredCapabilities: [...manifest.declaredCapabilities],
    requestedPermissions: [...manifest.requestedPermissions],
    resourceBudget: { ...manifest.resourceBudget },
    entry: manifest.entry ? { ...manifest.entry } : undefined,
  };
}

function fingerprint(manifest: ExtensionManifest): string {
  return createHash('sha256').update(JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    source: manifest.source,
    kind: manifest.kind,
    compatibility: manifest.compatibility,
    declaredCapabilities: manifest.declaredCapabilities,
    requestedPermissions: manifest.requestedPermissions,
    dataBoundary: manifest.dataBoundary,
    resourceBudget: manifest.resourceBudget,
    entry: manifest.entry,
    revision: manifest.revision,
    status: manifest.status,
  })).digest('hex');
}

function assertTransition(current: ExtensionManifest, next: ExtensionStatus): void {
  if (current.status === 'revoked') throw new Error('已撤销 extension 不得变更状态；必须登记新的 id 与来源摘要');
  const allowed: Readonly<Record<ExtensionStatus, readonly ExtensionStatus[]>> = {
    discovered: ['reviewed', 'disabled', 'revoked'],
    reviewed: ['installed', 'disabled', 'revoked'],
    installed: ['disabled', 'revoked'],
    disabled: ['installed', 'revoked'],
    revoked: [],
  };
  if (!allowed[current.status].includes(next)) throw new Error(`extension 状态不能从 ${current.status} 转为 ${next}`);
}

/** 进程内测试存储；与 SQLite 实现同样只接受连续 revision。 */
export class InMemoryExtensionManifestStore implements ExtensionManifestStore {
  private readonly current = new Map<string, ExtensionManifest>();
  private readonly revisions = new Map<string, ExtensionManifest[]>();

  load(id: string): ExtensionManifest | undefined {
    assertIdentifier(id, 'id');
    const manifest = this.current.get(id);
    return manifest ? copyManifest(manifest) : undefined;
  }

  append(manifest: ExtensionManifest): void {
    const previous = this.current.get(manifest.id);
    if (!previous && manifest.revision !== 1) throw new Error('新 extension manifest revision 必须为 1');
    if (previous && manifest.revision !== previous.revision + 1) throw new Error('extension manifest revision 必须连续递增');
    const copied = copyManifest(manifest);
    this.current.set(manifest.id, copied);
    const history = this.revisions.get(manifest.id) ?? [];
    history.push(copyManifest(copied));
    this.revisions.set(manifest.id, history);
  }

  list(): readonly ExtensionManifest[] {
    return [...this.current.values()].map(copyManifest).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly ExtensionManifest[] {
    assertIdentifier(id, 'id');
    return (this.revisions.get(id) ?? []).map(copyManifest);
  }
}

/** SQLite WAL 追加账本；只存审查后的 metadata，永远不存包内容、token 或运行期句柄。 */
export class SqliteExtensionManifestStore implements ExtensionManifestStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_manifest_revisions (
        extension_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (extension_id, revision)
      );
    `);
  }

  load(id: string): ExtensionManifest | undefined {
    assertIdentifier(id, 'id');
    const row = this.db.prepare(`
      SELECT manifest_json FROM extension_manifest_revisions WHERE extension_id = ? ORDER BY revision DESC LIMIT 1
    `).get(id) as { manifest_json: string } | undefined;
    return row ? copyManifest(JSON.parse(row.manifest_json) as ExtensionManifest) : undefined;
  }

  append(manifest: ExtensionManifest): void {
    const current = this.load(manifest.id);
    if (!current && manifest.revision !== 1) throw new Error('新 extension manifest revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('extension manifest revision 必须连续递增');
    this.db.prepare(`
      INSERT INTO extension_manifest_revisions (extension_id, revision, manifest_json, fingerprint) VALUES (?, ?, ?, ?)
    `).run(manifest.id, manifest.revision, JSON.stringify(copyManifest(manifest)), fingerprint(manifest));
  }

  list(): readonly ExtensionManifest[] {
    const rows = this.db.prepare(`
      SELECT revision.manifest_json FROM extension_manifest_revisions AS revision
      JOIN (SELECT extension_id, MAX(revision) AS latest FROM extension_manifest_revisions GROUP BY extension_id) AS latest
        ON latest.extension_id = revision.extension_id AND latest.latest = revision.revision
    `).all() as unknown as readonly { manifest_json: string }[];
    return rows.map((row) => copyManifest(JSON.parse(row.manifest_json) as ExtensionManifest))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly ExtensionManifest[] {
    assertIdentifier(id, 'id');
    const rows = this.db.prepare(`
      SELECT manifest_json FROM extension_manifest_revisions WHERE extension_id = ? ORDER BY revision ASC
    `).all(id) as unknown as readonly { manifest_json: string }[];
    return rows.map((row) => copyManifest(JSON.parse(row.manifest_json) as ExtensionManifest));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Control-plane-only registry. Discovery, review and installation mutate only immutable metadata revisions.
 * No method imports source code, spawns a process, opens a network connection, reads secrets or authorizes a capability.
 */
export class ExtensionRegistry {
  constructor(private readonly store: ExtensionManifestStore) {}

  discover(request: DiscoverExtensionRequest): ExtensionManifest {
    assertManifestRequest(request);
    if (this.store.load(request.id)) throw new Error(`extension ${request.id} 已登记；请使用新 id 表示新来源`);
    const manifest: ExtensionManifest = {
      schemaVersion: 1,
      id: request.id,
      version: request.version,
      apiVersion: EXTENSION_API_VERSION,
      kind: request.kind,
      displayName: request.displayName.trim(),
      source: { ...request.source, locator: request.source.locator.trim(), digest: request.source.digest.toLocaleLowerCase() },
      compatibility: { hostApiVersion: EXTENSION_API_VERSION, protocols: [...request.compatibility.protocols] },
      declaredCapabilities: [...request.declaredCapabilities],
      requestedPermissions: [...request.requestedPermissions],
      dataBoundary: request.dataBoundary,
      resourceBudget: { ...request.resourceBudget },
      entry: request.entry ? { ...request.entry } : undefined,
      status: 'discovered',
      revision: 1,
      discoveredAt: request.at,
      updatedAt: request.at,
      note: request.note?.trim() || undefined,
    };
    this.store.append(manifest);
    return copyManifest(manifest);
  }

  review(id: string, reviewedBy: string, at: number, note?: string): ExtensionManifest {
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    return this.transition(this.require(id), 'reviewed', reviewedBy, at, note);
  }

  /** 安装仅确认受审制品 digest；实际下载和加载必须由后续 Extension Host 显式负责。 */
  install(id: string, verifiedDigest: string, reviewedBy: string, at: number, note?: string): ExtensionManifest {
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    assertDigest(verifiedDigest, 'verifiedDigest');
    const current = this.require(id);
    if (current.source.digest !== verifiedDigest.toLocaleLowerCase()) throw new Error('verifiedDigest 与审查来源摘要不一致');
    return this.transition(current, 'installed', reviewedBy, at, note);
  }

  disable(id: string, reviewedBy: string, at: number, note?: string): ExtensionManifest {
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    return this.transition(this.require(id), 'disabled', reviewedBy, at, note);
  }

  revoke(id: string, reviewedBy: string, at: number, note?: string): ExtensionManifest {
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    return this.transition(this.require(id), 'revoked', reviewedBy, at, note);
  }

  get(id: string): ExtensionManifest | undefined {
    return this.store.load(id);
  }

  list(): readonly ExtensionManifest[] {
    return this.store.list();
  }

  history(id: string): readonly ExtensionManifest[] {
    return this.store.history(id);
  }

  /** 仅 `installed` metadata 才可被下一阶段的 Activation Planner 考虑。 */
  eligible(): readonly ExtensionManifest[] {
    return this.store.list().filter((manifest) => manifest.status === 'installed');
  }

  private transition(current: ExtensionManifest, status: ExtensionStatus, reviewedBy: string, at: number, note?: string): ExtensionManifest {
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 字符');
    assertTransition(current, status);
    if (!DECISIVE_STATUSES.has(status) && status !== 'reviewed') throw new Error('extension 状态未被支持');
    const next: ExtensionManifest = {
      ...copyManifest(current),
      status,
      revision: current.revision + 1,
      updatedAt: at,
      reviewedBy,
      reviewedAt: status === 'reviewed' ? at : current.reviewedAt,
      installedAt: status === 'installed' ? at : current.installedAt,
      disabledAt: status === 'disabled' ? at : current.disabledAt,
      revokedAt: status === 'revoked' ? at : current.revokedAt,
      note: note?.trim() || current.note,
    };
    this.store.append(next);
    return copyManifest(next);
  }

  private require(id: string): ExtensionManifest {
    assertIdentifier(id, 'id');
    const manifest = this.store.load(id);
    if (!manifest) throw new Error(`extension ${id} 不存在`);
    return manifest;
  }
}
