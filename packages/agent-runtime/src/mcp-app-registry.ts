// 一个文件=一种作用：MCP App 注册持久化与生命周期管理（镜像 mcp-registry）。
//
// 与 MCP server 注册表同一套治理语义：人工审查 → 显式启用 → 可撤销；
// 注册时经 @awo/protocol 的 validateMcpAppManifest 对照**已登记的 server
// manifest** 做准入校验（工具白名单只能引用本服务器已登记工具，跨服务器
// 引用整单拒绝）。存储为 append-only 修订链（SQLite / 内存双实现），
// 只保存审核后的配置 DTO，不持有密钥、运行进程或应用 HTML 内容。
//
// 注册表只管理登记与授权状态；应用 HTML 的获取、沙箱渲染与工具执行
// 分别属于宿主组件（McpAppHost）与工具网关（McpAppToolGateway）。

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateMcpAppManifest, type McpAppAdmission, type McpAppResourceManifest } from '@awo/protocol';
import type { McpManifestStore } from './mcp-registry.js';

export type McpAppStatus = 'registered' | 'enabled' | 'disabled' | 'revoked';

export interface McpAppManifest {
  schemaVersion: 1;
  id: string;
  serverId: string;
  displayName: string;
  htmlResourceUri: string;
  requestedToolNames: readonly string[];
  apiOrigins?: readonly string[];
  /** 准入校验通过的工具白名单 = requested ∩ server declaredTools。 */
  admittedToolNames: readonly string[];
  status: McpAppStatus;
  revision: number;
  reviewedBy: string;
  createdAt: number;
  updatedAt: number;
  enabledAt?: number;
  disabledAt?: number;
  revokedAt?: number;
  note?: string;
}

export interface McpAppStore {
  load(id: string): McpAppManifest | undefined;
  append(manifest: McpAppManifest): void;
  list(): readonly McpAppManifest[];
  history(id: string): readonly McpAppManifest[];
}

export interface RegisterMcpAppRequest {
  id: string;
  serverId: string;
  displayName: string;
  htmlResourceUri: string;
  requestedToolNames: readonly string[];
  apiOrigins?: readonly string[];
  reviewedBy: string;
  at: number;
  note?: string;
}

const APP_ID = /^mcpapp-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} 必须是 1-128 位安全标识符`);
}

function assertAppId(value: string): void {
  if (!APP_ID.test(value)) throw new Error('应用 id 必须是 mcpapp- 前缀的安全标识符');
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function copyApp(manifest: McpAppManifest): McpAppManifest {
  return {
    ...manifest,
    requestedToolNames: [...manifest.requestedToolNames],
    admittedToolNames: [...manifest.admittedToolNames],
    ...(manifest.apiOrigins ? { apiOrigins: [...manifest.apiOrigins] } : {}),
  };
}

function validateRegister(request: RegisterMcpAppRequest): void {
  assertAppId(request.id);
  assertIdentifier(request.serverId, 'serverId');
  assertIdentifier(request.reviewedBy, 'reviewedBy');
  if (!request.displayName.trim() || request.displayName.length > 160) throw new Error('displayName 必须是 1-160 字符');
  if (!request.htmlResourceUri.trim() || request.htmlResourceUri.length > 512) throw new Error('htmlResourceUri 必须是 1-512 字符');
  if (!Array.isArray(request.requestedToolNames) || request.requestedToolNames.length === 0 || request.requestedToolNames.length > 64) {
    throw new Error('requestedToolNames 必须是 1-64 项');
  }
  assertEpoch(request.at, 'at');
  if (request.note !== undefined && request.note.length > 2_000) throw new Error('note 不得超过 2000 字符');
}

function appFingerprint(manifest: McpAppManifest): string {
  return createHash('sha256').update(JSON.stringify({
    id: manifest.id,
    serverId: manifest.serverId,
    htmlResourceUri: manifest.htmlResourceUri,
    requestedToolNames: manifest.requestedToolNames,
    apiOrigins: manifest.apiOrigins,
    admittedToolNames: manifest.admittedToolNames,
    revision: manifest.revision,
  })).digest('hex');
}

/** 登记态/禁用态/撤销态均不可被宿主解析；只能显式 enable 后才进入候选集合。 */
export class InMemoryMcpAppStore implements McpAppStore {
  private readonly current = new Map<string, McpAppManifest>();
  private readonly revisions = new Map<string, McpAppManifest[]>();

  load(id: string): McpAppManifest | undefined {
    const manifest = this.current.get(id);
    return manifest ? copyApp(manifest) : undefined;
  }

  append(manifest: McpAppManifest): void {
    const previous = this.current.get(manifest.id);
    if (!previous && manifest.revision !== 1) throw new Error('新 MCP App manifest revision 必须为 1');
    if (previous && manifest.revision !== previous.revision + 1) throw new Error('MCP App manifest revision 必须追加递增');
    const copied = copyApp(manifest);
    this.current.set(manifest.id, copied);
    const history = this.revisions.get(manifest.id) ?? [];
    history.push(copyApp(copied));
    this.revisions.set(manifest.id, history);
  }

  list(): readonly McpAppManifest[] {
    return [...this.current.values()].map(copyApp).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly McpAppManifest[] {
    return (this.revisions.get(id) ?? []).map(copyApp);
  }
}

/** SQLite append-only 修订存储；表结构与 mcp_manifest_revisions 对称。 */
export class SqliteMcpAppStore implements McpAppStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_app_manifest_revisions (
        app_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        manifest_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY (app_id, revision)
      );
    `);
  }

  load(id: string): McpAppManifest | undefined {
    const row = this.db.prepare(`
      SELECT manifest_json FROM mcp_app_manifest_revisions WHERE app_id = ? ORDER BY revision DESC LIMIT 1
    `).get(id) as { manifest_json: string } | undefined;
    return row ? copyApp(JSON.parse(row.manifest_json) as McpAppManifest) : undefined;
  }

  append(manifest: McpAppManifest): void {
    this.db.prepare(`
      INSERT INTO mcp_app_manifest_revisions (app_id, revision, manifest_json, fingerprint) VALUES (?, ?, ?, ?)
    `).run(manifest.id, manifest.revision, JSON.stringify(copyApp(manifest)), appFingerprint(manifest));
  }

  list(): readonly McpAppManifest[] {
    const rows = this.db.prepare(`
      SELECT revision.manifest_json FROM mcp_app_manifest_revisions AS revision
      JOIN (SELECT app_id, MAX(revision) AS latest FROM mcp_app_manifest_revisions GROUP BY app_id) AS latest
        ON latest.app_id = revision.app_id AND latest.latest = revision.revision
    `).all() as unknown as readonly { manifest_json: string }[];
    return rows.map((row) => copyApp(JSON.parse(row.manifest_json) as McpAppManifest))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  history(id: string): readonly McpAppManifest[] {
    const rows = this.db.prepare(`
      SELECT manifest_json FROM mcp_app_manifest_revisions WHERE app_id = ? ORDER BY revision ASC
    `).all(id) as unknown as readonly { manifest_json: string }[];
    return rows.map((row) => copyApp(JSON.parse(row.manifest_json) as McpAppManifest));
  }

  close(): void {
    this.db.close();
  }
}

export interface ResolveMcpAppResult {
  readonly admission: McpAppAdmission;
  readonly serverRevision: number;
}

/**
 * MCP App Registry：准入校验 + 生命周期治理的唯一所有者。
 * 宿主渲染前必须 resolveApp 拿到 admission；工具执行走 McpAppToolGateway。
 */
export class McpAppRegistry {
  constructor(
    private readonly appStore: McpAppStore,
    private readonly serverStore: McpManifestStore,
  ) {}

  /** 注册：应用清单必须通过 protocol 准入校验，且声明的服务器必须已登记并显式启用。 */
  register(request: RegisterMcpAppRequest): McpAppManifest {
    validateRegister(request);
    if (this.appStore.load(request.id)) throw new Error(`MCP App ${request.id} 已登记；请创建新 manifest 而非隐式覆盖`);
    const server = this.serverStore.load(request.serverId);
    if (!server) throw new Error(`MCP server ${request.serverId} 未登记，无法为它注册应用`);
    if (server.status !== 'enabled') throw new Error(`MCP server ${request.serverId} 尚未显式启用`);
    const candidate: McpAppResourceManifest = {
      schemaVersion: 1,
      id: request.id,
      serverId: request.serverId,
      displayName: request.displayName.trim(),
      htmlResourceUri: request.htmlResourceUri.trim(),
      requestedToolNames: [...request.requestedToolNames],
      ...(request.apiOrigins ? { apiOrigins: [...request.apiOrigins] } : {}),
    };
    const admission = validateMcpAppManifest(candidate, server);
    if (!admission.ok) throw new Error(`MCP App 准入校验未通过：${admission.reason}`);
    const manifest: McpAppManifest = {
      schemaVersion: 1,
      id: request.id,
      serverId: request.serverId,
      displayName: request.displayName.trim(),
      htmlResourceUri: request.htmlResourceUri.trim(),
      requestedToolNames: [...request.requestedToolNames],
      ...(request.apiOrigins ? { apiOrigins: [...request.apiOrigins] } : {}),
      admittedToolNames: [...admission.admission.admittedToolNames],
      status: 'registered',
      revision: 1,
      reviewedBy: request.reviewedBy,
      createdAt: request.at,
      updatedAt: request.at,
      note: request.note?.trim() || undefined,
    };
    this.appStore.append(manifest);
    return copyApp(manifest);
  }

  enable(id: string, reviewedBy: string, at: number, note?: string): McpAppManifest {
    const current = this.require(id);
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (current.status === 'revoked') throw new Error('已撤销 MCP App manifest 不得重新启用；必须人工重新登记');
    if (current.status === 'enabled') return current;
    // 服务器必须仍处于启用态：server 被禁用后其应用不得单独启用。
    const server = this.serverStore.load(current.serverId);
    if (!server || server.status !== 'enabled') throw new Error(`MCP server ${current.serverId} 未处于启用态，应用无法启用`);
    return this.appendStatus(current, 'enabled', reviewedBy, at, note);
  }

  disable(id: string, reviewedBy: string, at: number, note?: string): McpAppManifest {
    const current = this.require(id);
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (current.status === 'revoked' || current.status === 'disabled') return current;
    return this.appendStatus(current, 'disabled', reviewedBy, at, note);
  }

  revoke(id: string, reviewedBy: string, at: number, note?: string): McpAppManifest {
    const current = this.require(id);
    assertIdentifier(reviewedBy, 'reviewedBy');
    assertEpoch(at, 'at');
    if (current.status === 'revoked') return current;
    return this.appendStatus(current, 'revoked', reviewedBy, at, note);
  }

  list(): readonly McpAppManifest[] {
    return this.appStore.list().map(copyApp);
  }

  enabled(): readonly McpAppManifest[] {
    return this.appStore.list().filter((manifest) => manifest.status === 'enabled').map(copyApp);
  }

  /** 宿主渲染前的最后一步：仅启用态可解析出 admission（含准入工具白名单）。 */
  resolveApp(id: string): ResolveMcpAppResult {
    const manifest = this.require(id);
    if (manifest.status !== 'enabled') throw new Error(`MCP App ${id} 尚未显式启用`);
    const server = this.serverStore.load(manifest.serverId);
    if (!server || server.status !== 'enabled') throw new Error(`MCP server ${manifest.serverId} 未处于启用态`);
    // 再准入一次：登记后 server 的工具表可能被修订，白名单必须仍然成立。
    const admission = validateMcpAppManifest(
      {
        schemaVersion: 1,
        id: manifest.id,
        serverId: manifest.serverId,
        displayName: manifest.displayName,
        htmlResourceUri: manifest.htmlResourceUri,
        requestedToolNames: manifest.requestedToolNames,
        ...(manifest.apiOrigins ? { apiOrigins: manifest.apiOrigins } : {}),
      },
      server,
    );
    if (!admission.ok) throw new Error(`MCP App ${id} 准入校验未通过：${admission.reason}`);
    return { admission: admission.admission, serverRevision: server.revision };
  }

  private appendStatus(
    current: McpAppManifest,
    status: Exclude<McpAppStatus, 'registered'>,
    reviewedBy: string,
    at: number,
    note?: string,
  ): McpAppManifest {
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 字符');
    const next: McpAppManifest = {
      ...copyApp(current),
      status,
      revision: current.revision + 1,
      reviewedBy,
      updatedAt: at,
      enabledAt: status === 'enabled' ? at : current.enabledAt,
      disabledAt: status === 'disabled' ? at : current.disabledAt,
      revokedAt: status === 'revoked' ? at : current.revokedAt,
      note: note?.trim() || current.note,
    };
    this.appStore.append(next);
    return copyApp(next);
  }

  private require(id: string): McpAppManifest {
    assertAppId(id);
    const manifest = this.appStore.load(id);
    if (!manifest) throw new Error(`MCP App ${id} 不存在`);
    return manifest;
  }
}
