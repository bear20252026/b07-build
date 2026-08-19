import type { Capability } from '@awo/protocol';
import {
  AdministratorAuthorityLedger,
  type AdministratorAuthorityLeaseV1,
  MAX_ADMINISTRATOR_LEASE_MS,
} from './execution-authority.js';

export const TRUSTED_DESKTOP_ISSUER_SCHEMA_VERSION = 1 as const;

export type TrustedDesktopPlatform = 'windows' | 'macos' | 'linux' | 'unknown';
export type TrustedDesktopIssuerStatus = 'registered' | 'trusted' | 'disabled' | 'revoked';

export interface TrustedDesktopIssuerManifestV1 {
  schemaVersion: typeof TRUSTED_DESKTOP_ISSUER_SCHEMA_VERSION;
  issuerId: string;
  displayName: string;
  platform: TrustedDesktopPlatform;
  status: TrustedDesktopIssuerStatus;
  revision: number;
  registeredAt: number;
  updatedAt: number;
  canIssueAdministratorLeases: true;
  canAuthenticateRenderer: false;
  canExecute: false;
}

export interface RegisterTrustedDesktopIssuerInput {
  issuerId: string;
  displayName: string;
  platform: TrustedDesktopPlatform;
  at: number;
}

export interface TrustedDesktopIssuerStore {
  load(issuerId: string): TrustedDesktopIssuerManifestV1 | undefined;
  append(manifest: TrustedDesktopIssuerManifestV1): void;
  list(): readonly TrustedDesktopIssuerManifestV1[];
  close?(): void;
}

export interface VerifiedDesktopLeaseRequest {
  /** 由未来 native host 完成认证并传入；renderer/window label/HTTP body 不是有效 issuer。 */
  issuerId: string;
  leaseId: string;
  operatorId: string;
  taskId: string;
  runId: string;
  allowedCapabilities: readonly Capability[];
  /** 调用方已经对维护理由执行 SHA-256；明文理由永不进入该接口或账本。 */
  reasonDigest: string;
  issuedAt: number;
  expiresAt: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PLATFORMS = new Set<TrustedDesktopPlatform>(['windows', 'macos', 'linux', 'unknown']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function copyManifest(manifest: TrustedDesktopIssuerManifestV1): TrustedDesktopIssuerManifestV1 {
  return { ...manifest };
}

/**
 * 只保存可信桌面宿主 metadata 的 append-only registry。
 * `trusted` 代表宿主已经由未来 native control plane 验证；本类不伪造或替代 OS 身份认证。
 */
export class TrustedDesktopIssuerRegistry {
  constructor(private readonly store: TrustedDesktopIssuerStore) {}

  register(input: RegisterTrustedDesktopIssuerInput): TrustedDesktopIssuerManifestV1 {
    assertIdentifier(input.issuerId, 'issuerId');
    if (!input.displayName.trim() || input.displayName.length > 160) throw new Error('displayName 必须是 1-160 字符');
    if (!PLATFORMS.has(input.platform)) throw new Error('platform 未被支持');
    assertEpoch(input.at, 'at');
    if (this.store.load(input.issuerId)) throw new Error(`可信桌面 issuer 已登记：${input.issuerId}`);
    const manifest: TrustedDesktopIssuerManifestV1 = {
      schemaVersion: TRUSTED_DESKTOP_ISSUER_SCHEMA_VERSION,
      issuerId: input.issuerId,
      displayName: input.displayName.trim(),
      platform: input.platform,
      status: 'registered',
      revision: 1,
      registeredAt: input.at,
      updatedAt: input.at,
      canIssueAdministratorLeases: true,
      canAuthenticateRenderer: false,
      canExecute: false,
    };
    this.store.append(manifest);
    return copyManifest(manifest);
  }

  setStatus(issuerId: string, status: Exclude<TrustedDesktopIssuerStatus, 'registered'>, at: number): TrustedDesktopIssuerManifestV1 {
    assertIdentifier(issuerId, 'issuerId');
    assertEpoch(at, 'at');
    const current = this.store.load(issuerId);
    if (!current) throw new Error(`可信桌面 issuer 不存在：${issuerId}`);
    if (current.status === 'revoked') throw new Error('已撤销 issuer 不得改变状态；必须登记新的 issuerId');
    if (current.status === status) throw new Error('issuer 已处于目标状态');
    if (status === 'trusted' && current.status !== 'registered' && current.status !== 'disabled') {
      throw new Error('issuer 只能从 registered 或 disabled 转为 trusted');
    }
    const next: TrustedDesktopIssuerManifestV1 = { ...current, status, revision: current.revision + 1, updatedAt: at };
    this.store.append(next);
    return copyManifest(next);
  }

  get(issuerId: string): TrustedDesktopIssuerManifestV1 | undefined {
    assertIdentifier(issuerId, 'issuerId');
    const manifest = this.store.load(issuerId);
    return manifest ? copyManifest(manifest) : undefined;
  }

  list(): readonly TrustedDesktopIssuerManifestV1[] {
    return this.store.list().map(copyManifest).sort((left, right) => left.issuerId.localeCompare(right.issuerId));
  }
}

/**
 * 管理员租约的 future-native-host 签发端口。它不执行认证、不读取 OS/secret、不提供 HTTP，
 * 仅在 host 已验证、issuer 已受信与 capability ceiling 严格匹配时委托既有 append-only ledger。
 */
export class TrustedDesktopLeaseIssuer {
  constructor(
    private readonly issuers: TrustedDesktopIssuerRegistry,
    private readonly leases: AdministratorAuthorityLedger,
    private readonly now: () => number = Date.now,
  ) {}

  issue(request: VerifiedDesktopLeaseRequest, capabilityCeiling: readonly Capability[]): AdministratorAuthorityLeaseV1 {
    assertIdentifier(request.issuerId, 'issuerId');
    assertIdentifier(request.leaseId, 'leaseId');
    assertIdentifier(request.operatorId, 'operatorId');
    assertIdentifier(request.taskId, 'taskId');
    assertIdentifier(request.runId, 'runId');
    assertEpoch(request.issuedAt, 'issuedAt');
    assertEpoch(request.expiresAt, 'expiresAt');
    if (!DIGEST.test(request.reasonDigest)) throw new Error('reasonDigest 必须是 SHA-256 十六进制摘要');
    if (request.expiresAt <= request.issuedAt || request.expiresAt - request.issuedAt > MAX_ADMINISTRATOR_LEASE_MS) {
      throw new Error(`管理员租约有效期必须为 1-${MAX_ADMINISTRATOR_LEASE_MS}ms`);
    }
    if (Math.abs(this.now() - request.issuedAt) > 60_000) throw new Error('签发请求时间与可信宿主时间偏差过大，失败关闭');
    if (request.allowedCapabilities.length === 0 || new Set(request.allowedCapabilities).size !== request.allowedCapabilities.length) {
      throw new Error('管理员租约必须包含无重复 capability');
    }
    if (request.allowedCapabilities.some((capability) => !capabilityCeiling.includes(capability))) {
      throw new Error('管理员租约 capability 超出调用方已声明的 capability ceiling');
    }
    const issuer = this.issuers.get(request.issuerId);
    if (!issuer || issuer.status !== 'trusted') throw new Error('可信桌面 issuer 未登记、未验证、已停用或已撤销');
    return this.leases.issue({
      leaseId: request.leaseId,
      operatorId: request.operatorId,
      taskId: request.taskId,
      runId: request.runId,
      allowedCapabilities: request.allowedCapabilities,
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
      reasonDigest: request.reasonDigest,
    });
  }
}

export class InMemoryTrustedDesktopIssuerStore implements TrustedDesktopIssuerStore {
  private readonly current = new Map<string, TrustedDesktopIssuerManifestV1>();

  load(issuerId: string): TrustedDesktopIssuerManifestV1 | undefined {
    assertIdentifier(issuerId, 'issuerId');
    const manifest = this.current.get(issuerId);
    return manifest ? copyManifest(manifest) : undefined;
  }

  append(manifest: TrustedDesktopIssuerManifestV1): void {
    assertIdentifier(manifest.issuerId, 'issuerId');
    const current = this.current.get(manifest.issuerId);
    if (!current && manifest.revision !== 1) throw new Error('新 issuer revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('issuer revision 必须严格追加');
    this.current.set(manifest.issuerId, copyManifest(manifest));
  }

  list(): readonly TrustedDesktopIssuerManifestV1[] {
    return [...this.current.values()].map(copyManifest).sort((left, right) => left.issuerId.localeCompare(right.issuerId));
  }
}
