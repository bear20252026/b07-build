import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Capability,
  CapabilityDecision,
  CapabilityEvaluation,
  CapabilityPolicy,
} from '@awo/protocol';

export type McpTransport = 'stdio' | 'streamable_http';
export type McpServerStatus = 'registered' | 'enabled' | 'disabled' | 'revoked';
export type McpToolRisk = 'low' | 'medium' | 'high';

export interface McpToolManifest {
  name: string;
  description: string;
  capability: Capability;
  risk: McpToolRisk;
}

export interface McpStdioConnection {
  transport: 'stdio';
  /** 不使用 shell 字符串；未来执行层必须直接 spawn executable + args。 */
  executable: string;
  args: readonly string[];
}

export interface McpHttpConnection {
  transport: 'streamable_http';
  endpoint: string;
}

export type McpConnection = McpStdioConnection | McpHttpConnection;

export interface McpServerManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  connection: Readonly<McpConnection>;
  declaredTools: readonly McpToolManifest[];
  /** 人工审查所确认的可复现来源摘要；不保存包内容、密钥或 OAuth token。 */
  sourceDigest: string;
  status: McpServerStatus;
  revision: number;
  reviewedBy: string;
  createdAt: number;
  updatedAt: number;
  enabledAt?: number;
  disabledAt?: number;
  revokedAt?: number;
  note?: string;
}

export interface RegisterMcpServerRequest {
  id: string;
  displayName: string;
  connection: McpConnection;
  declaredTools: readonly McpToolManifest[];
  sourceDigest: string;
  reviewedBy: string;
  note?: string;
  at: number;
}

export interface McpManifestStore {
  load(id: string): McpServerManifest | undefined;
  append(manifest: McpServerManifest): void;
  list(): readonly McpServerManifest[];
  history(id: string): readonly McpServerManifest[];
}

export interface ResolvedMcpTool {
  serverId: string;
  serverRevision: number;
  transport: McpTransport;
  tool: McpToolManifest;
  sourceDigest: string;
}

export interface McpToolAuthorization {
  resolved: ResolvedMcpTool;
  decision: CapabilityDecision;
  reason: string;
  /** MCP manifest 与 policy 都不能替代审批或实时权限。 */
  canAuthorize: false;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECISION_RANK: Readonly<Record<CapabilityDecision, number>> = { allow: 0, require_approval: 1, deny: 2 };

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function copyTool(tool: McpToolManifest): McpToolManifest {
  return { ...tool };
}

function copyConnection(connection: McpConnection): McpConnection {
  return connection.transport === 'stdio'
    ? { transport: 'stdio', executable: connection.executable, args: [...connection.args] }
    : { transport: 'streamable_http', endpoint: connection.endpoint };
}

function copyManifest(manifest: McpServerManifest): McpServerManifest {
  return {
    ...manifest,
    connection: copyConnection(manifest.connection),
    declaredTools: manifest.declaredTools.map(copyTool),
  };
}

function validateConnection(connection: McpConnection): void {
  if (connection.transport === 'stdio') {
    if (!connection.executable.trim() || connection.executable.length > 512 || /[\r\n\0]/u.test(connection.executable)) {
      throw new Error('stdio executable 必须是 1-512 字符且不含控制换行');
    }
    if (connection.args.length > 32 || connection.args.some((arg) => arg.length > 1_024 || /[\r\n\0]/u.test(arg))) {
      throw new Error('stdio args 最多 32 个且不得含控制换行');
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(connection.endpoint);
  } catch {
    throw new Error('streamable_http endpoint 必须是绝对 URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLocaleLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('MCP HTTP endpoint 必须使用 https，或明确的本地回环 http');
  }
  if (url.username || url.password || url.hash) throw new Error('MCP HTTP endpoint 不得包含身份信息或片段');
}

function validateTools(tools: readonly McpToolManifest[]): void {
  if (tools.length === 0 || tools.length > 64) throw new Error('declaredTools 必须为 1-64 项显式白名单');
  const names = new Set<string>();
  for (const tool of tools) {
    assertIdentifier(tool.name, 'tool.name');
    if (names.has(tool.name)) throw new Error(`declaredTools 中 tool.name 重复：${tool.name}`);
    names.add(tool.name);
    if (!tool.description.trim() || tool.description.length > 1_000) throw new Error('tool.description 必须是 1-1000 字符');
    if (!['document.parse', 'model.chat', 'filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control'].includes(tool.capability)) {
      throw new Error('tool.capability 未在协议中声明');
    }
    if (!['low', 'medium', 'high'].includes(tool.risk)) throw new Error('tool.risk 必须是 low、medium 或 high');
  }
}

function validateRegister(request: RegisterMcpServerRequest): void {
  assertIdentifier(request.id, 'id');
  assertIdentifier(request.reviewedBy, 'reviewedBy');
  if (!request.displayName.trim() || request.displayName.length > 160) throw new Error('displayName 必须是 1-160 字符');
  if (!/^[a-f0-9]{64}$/i.test(request.sourceDigest)) throw new Error('sourceDigest 必须是 SHA-256 十六进制摘要');
  if (request.note !== undefined && request.note.length > 2_000) throw new Error('note 不得超过 2000 字符');
  assertEpoch(request.at, 'at');
  validateConnection(request.connection);
  validateTools(request.declaredTools);
}

function manifestFingerprint(manifest: McpServerManifest): string {
  return createHash('sha256').update(JSON.stringify({
    id: manifest.id,
    connection: manifest.connection,
    declaredTools: manifest.declaredTools,
    sourceDigest: manifest.sourceDigest,
    revision: manifest.revision,
  })).digest('hex');
}

/** 登记态/禁用态/撤销态均不可被运行时解析；只能显式 enable 后才进入候选集合。 */
export class InMemoryMcpManifestStore implements McpManifestStore {
  private readonly current = new Map<string, McpServerManifest>();
  private readonly revisions = new Map<string, McpServerManifest[]>();

  load(id: string): McpServerManifest | undefined {
    const manifest = this.current.get(id);
    return manifest ? copyManifest(manifest) : undefined;
  }

  append(manifest: McpServerManifest): void {
    const previous = this.current.get(manifest.id);
    if (!previous && manifest.revision !== 1) throw new Error('新 MCP manifest revision 必须为 1');
    if (previous && manifest.revision !== previous.revision + 1) throw new Error('MCP manifest revision 必须追加递增');
    const copied = copyManifest(manifest);
    this.current.set(manifest.id, copied);
    const history = this.revisions.get(manifest.id) ?? [];
    history.push(copyManifest(copied));
    this.revisions.set(manifest.id, history);
  }

  list(): readonly McpServerManifest[] {
    return [...this.current.values()].map(copyManifest).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly McpServerManifest[] {
    return (this.revisions.get(id) ?? []).map(copyManifest);
  }
}

/** SQLite append-only manifest 存储；只保存审核后的配置 DTO，不会持有密钥或运行进程。 */
export class SqliteMcpManifestStore implements McpManifestStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_manifest_revisions (
        server_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (server_id, revision)
      );
    `);
  }

  load(id: string): McpServerManifest | undefined {
    assertIdentifier(id, 'id');
    const row = this.db.prepare(`
      SELECT manifest_json FROM mcp_manifest_revisions WHERE server_id = ? ORDER BY revision DESC LIMIT 1
    `).get(id) as { manifest_json: string } | undefined;
    return row ? copyManifest(JSON.parse(row.manifest_json) as McpServerManifest) : undefined;
  }

  append(manifest: McpServerManifest): void {
    const current = this.load(manifest.id);
    if (!current && manifest.revision !== 1) throw new Error('新 MCP manifest revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('MCP manifest revision 必须追加递增');
    this.db.prepare(`
      INSERT INTO mcp_manifest_revisions (server_id, revision, manifest_json, fingerprint) VALUES (?, ?, ?, ?)
    `).run(manifest.id, manifest.revision, JSON.stringify(copyManifest(manifest)), manifestFingerprint(manifest));
  }

  list(): readonly McpServerManifest[] {
    const rows = this.db.prepare(`
      SELECT revision.manifest_json FROM mcp_manifest_revisions AS revision
      JOIN (SELECT server_id, MAX(revision) AS latest FROM mcp_manifest_revisions GROUP BY server_id) AS latest
        ON latest.server_id = revision.server_id AND latest.latest = revision.revision
    `).all() as unknown as readonly { manifest_json: string }[];
    return rows.map((row) => copyManifest(JSON.parse(row.manifest_json) as McpServerManifest))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly McpServerManifest[] {
    assertIdentifier(id, 'id');
    const rows = this.db.prepare(`
      SELECT manifest_json FROM mcp_manifest_revisions WHERE server_id = ? ORDER BY revision ASC
    `).all(id) as unknown as readonly { manifest_json: string }[];
    return rows.map((row) => copyManifest(JSON.parse(row.manifest_json) as McpServerManifest));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * MCP Registry 只管理人工审查、显式启用及工具白名单；它绝不下载、安装、spawn、连接或转发 token。
 */
export class McpRegistry {
  constructor(private readonly store: McpManifestStore) {}

  register(request: RegisterMcpServerRequest): McpServerManifest {
    validateRegister(request);
    if (this.store.load(request.id)) throw new Error(`MCP server ${request.id} 已登记；请创建新 manifest 而非隐式覆盖`);
    const manifest: McpServerManifest = {
      schemaVersion: 1,
      id: request.id,
      displayName: request.displayName.trim(),
      connection: copyConnection(request.connection),
      declaredTools: request.declaredTools.map(copyTool),
      sourceDigest: request.sourceDigest.toLocaleLowerCase(),
      status: 'registered',
      revision: 1,
      reviewedBy: request.reviewedBy,
      createdAt: request.at,
      updatedAt: request.at,
      note: request.note?.trim() || undefined,
    };
    this.store.append(manifest);
    return copyManifest(manifest);
  }

  enable(id: string, reviewedBy: string, at: number, note?: string): McpServerManifest {
    const current = this.require(id);
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (current.status === 'revoked') throw new Error('已撤销 MCP manifest 不得重新启用；必须人工重新登记');
    if (current.status === 'enabled') return current;
    return this.appendStatus(current, 'enabled', reviewedBy, at, note);
  }

  disable(id: string, reviewedBy: string, at: number, note?: string): McpServerManifest {
    const current = this.require(id);
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (current.status === 'revoked') return current;
    if (current.status === 'disabled') return current;
    return this.appendStatus(current, 'disabled', reviewedBy, at, note);
  }

  revoke(id: string, reviewedBy: string, at: number, note?: string): McpServerManifest {
    const current = this.require(id);
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (current.status === 'revoked') return current;
    return this.appendStatus(current, 'revoked', reviewedBy, at, note);
  }

  list(): readonly McpServerManifest[] {
    return this.store.list().map(copyManifest);
  }

  enabled(): readonly McpServerManifest[] {
    return this.store.list().filter((manifest) => manifest.status === 'enabled').map(copyManifest);
  }

  resolveTool(serverId: string, toolName: string): ResolvedMcpTool {
    const manifest = this.require(serverId);
    assertIdentifier(toolName, 'toolName');
    if (manifest.status !== 'enabled') throw new Error(`MCP server ${serverId} 尚未显式启用`);
    const tool = manifest.declaredTools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`MCP tool ${toolName} 未在 manifest 白名单中`);
    return {
      serverId: manifest.id,
      serverRevision: manifest.revision,
      transport: manifest.connection.transport,
      tool: copyTool(tool),
      sourceDigest: manifest.sourceDigest,
    };
  }

  authorizeTool(
    serverId: string,
    toolName: string,
    request: { taskId: string; runId: string; actionId: string },
    capabilityPolicy: CapabilityPolicy,
  ): McpToolAuthorization {
    assertIdentifier(request.taskId, 'taskId');
    assertIdentifier(request.runId, 'runId');
    assertIdentifier(request.actionId, 'actionId');
    const resolved = this.resolveTool(serverId, toolName);
    const external = capabilityPolicy.evaluate({
      capability: resolved.tool.capability,
      risk: resolved.tool.risk,
      taskId: request.taskId,
      runId: request.runId,
      actionId: request.actionId,
    });
    const manifestEvaluation: CapabilityEvaluation = resolved.tool.risk === 'high'
      ? { decision: 'require_approval', reason: '高风险 MCP 工具即使已登记也必须进入审批门控' }
      : { decision: 'allow', reason: 'MCP manifest 已显式启用且工具命中白名单' };
    const stricter = DECISION_RANK[external.decision] >= DECISION_RANK[manifestEvaluation.decision]
      ? external
      : manifestEvaluation;
    return {
      resolved,
      decision: stricter.decision,
      reason: `${manifestEvaluation.reason}；外部能力策略：${external.reason}`,
      canAuthorize: false,
    };
  }

  private appendStatus(
    current: McpServerManifest,
    status: Exclude<McpServerStatus, 'registered'>,
    reviewedBy: string,
    at: number,
    note?: string,
  ): McpServerManifest {
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 字符');
    const next: McpServerManifest = {
      ...current,
      connection: copyConnection(current.connection),
      declaredTools: current.declaredTools.map(copyTool),
      status,
      revision: current.revision + 1,
      reviewedBy,
      updatedAt: at,
      enabledAt: status === 'enabled' ? at : current.enabledAt,
      disabledAt: status === 'disabled' ? at : current.disabledAt,
      revokedAt: status === 'revoked' ? at : current.revokedAt,
      note: note?.trim() || current.note,
    };
    this.store.append(next);
    return copyManifest(next);
  }

  private require(id: string): McpServerManifest {
    assertIdentifier(id, 'id');
    const manifest = this.store.load(id);
    if (!manifest) throw new Error(`MCP server ${id} 不存在`);
    return manifest;
  }
}
