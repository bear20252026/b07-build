import { createPublicKey, randomBytes, verify } from 'node:crypto';
import {
  COMPONENT_MANAGEMENT_SCHEMA_VERSION,
  componentManagementPayloadDigest,
  type ComponentManagementAction,
  type ComponentManagementAuthority,
  type ComponentManagementIntentV1,
  type ComponentManagementPayload,
  type ComponentManagementReceiptV1,
  type VerifiedComponentManagementAttestationV1,
} from './component-management.js';
import { TrustedDesktopIssuerRegistry } from './trusted-desktop-issuer.js';

export const NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION = 1 as const;
export const MAX_NATIVE_HOST_CHALLENGE_MS = 60_000;

export type NativeHostTransport = 'native-messaging' | 'webview2-isolated-host' | 'desktop-ipc';
export type NativeHostTrustStatus = 'registered' | 'trusted' | 'disabled' | 'revoked';
export type NativeHostChallengeState = 'issued' | 'consumed';
export type NativeHostChallengeOutcome = 'verified' | 'rejected';
export type NativeHostAuthenticationReason =
  | 'invalid-envelope'
  | 'unknown-challenge'
  | 'nonce-consumed'
  | 'challenge-expired'
  | 'issuer-untrusted'
  | 'bridge-untrusted'
  | 'challenge-mismatch'
  | 'origin-mismatch'
  | 'signature-invalid';

export interface NativeHostBridgeTrustManifestV1 {
  schemaVersion: typeof NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION;
  issuerId: string;
  bridgeId: string;
  transport: NativeHostTransport;
  /** 精确固定来源；禁止通配符。该事实只能由平台 native transport adapter 提供，不接受 renderer/HTTP 声明。 */
  expectedCallerOrigin: string;
  keyId: string;
  /** 仅保存 Ed25519 公钥 PEM；私钥不进入此系统、SQLite、Gateway、Workbench 或日志。 */
  publicKeyPem: string;
  allowedActions: readonly ComponentManagementAction[];
  status: NativeHostTrustStatus;
  revision: number;
  registeredAt: number;
  updatedAt: number;
  canAuthenticateComponentManagement: true;
  canExecute: false;
}

export interface RegisterNativeHostBridgeInput {
  issuerId: string;
  bridgeId: string;
  transport: NativeHostTransport;
  expectedCallerOrigin: string;
  keyId: string;
  publicKeyPem: string;
  allowedActions: readonly ComponentManagementAction[];
  at: number;
}

export interface NativeHostBridgeTrustStore {
  load(issuerId: string, bridgeId: string): NativeHostBridgeTrustManifestV1 | undefined;
  append(manifest: NativeHostBridgeTrustManifestV1): void;
  list(): readonly NativeHostBridgeTrustManifestV1[];
  close?(): void;
}

export interface NativeHostChallengeV1 {
  schemaVersion: typeof NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION;
  nonce: string;
  issuerId: string;
  bridgeId: string;
  action: ComponentManagementAction;
  componentId: string;
  payloadDigest: string;
  issuedAt: number;
  expiresAt: number;
  canExecute: false;
}

export interface NativeHostChallengeRecordV1 {
  schemaVersion: typeof NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION;
  challenge: NativeHostChallengeV1;
  state: NativeHostChallengeState;
  revision: number;
  consumedAt?: number;
  outcome?: NativeHostChallengeOutcome;
  canExecute: false;
}

export interface NativeHostChallengeStore {
  load(nonce: string): NativeHostChallengeRecordV1 | undefined;
  append(record: NativeHostChallengeRecordV1): void;
  list(): readonly NativeHostChallengeRecordV1[];
  close?(): void;
}

/** native transport 已完成 caller origin 与进程身份采集后，传入其签名；浏览器/HTTP 请求不匹配此入口。 */
export interface NativeHostSignedChallengeEnvelopeV1 {
  schemaVersion: typeof NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION;
  nonce: string;
  issuerId: string;
  bridgeId: string;
  callerOrigin: string;
  keyId: string;
  signatureBase64: string;
}

export interface NativeHostAuthenticationDecisionV1 {
  schemaVersion: typeof NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION;
  allowed: boolean;
  reason: 'verified' | NativeHostAuthenticationReason;
  issuerId: string;
  bridgeId: string;
  action?: ComponentManagementAction;
  componentId?: string;
  attestation?: VerifiedComponentManagementAttestationV1;
  canExecute: false;
}

export interface NativeHostChallengeRequest {
  issuerId: string;
  bridgeId: string;
  action: ComponentManagementAction;
  componentId: string;
  payloadDigest: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NONCE = /^[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ORIGIN = /^(?:chrome-extension|edge-extension|app|awo-native):\/\/[A-Za-z0-9._-]{1,160}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TRANSPORTS = new Set<NativeHostTransport>(['native-messaging', 'webview2-isolated-host', 'desktop-ipc']);
const ACTIONS = new Set<ComponentManagementAction>(['register-candidate', 'verify-digest', 'review-provenance', 'record-lockfile', 'revoke-provenance']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} 必须是小写 SHA-256 十六进制摘要`);
}

function assertNativeCallerOrigin(value: string): void {
  if (!ORIGIN.test(value) || value.includes('*') || value.includes('@') || value.includes('?') || value.includes('#')) {
    throw new Error('expectedCallerOrigin 必须是无通配符的精确 native/extension origin');
  }
}

function copyManifest(value: NativeHostBridgeTrustManifestV1): NativeHostBridgeTrustManifestV1 {
  return { ...value, allowedActions: [...value.allowedActions] };
}

function copyChallenge(value: NativeHostChallengeV1): NativeHostChallengeV1 {
  return { ...value };
}

function copyRecord(value: NativeHostChallengeRecordV1): NativeHostChallengeRecordV1 {
  return { ...value, challenge: copyChallenge(value.challenge) };
}

function canonicalChallengePayload(challenge: NativeHostChallengeV1): string {
  return JSON.stringify({
    schemaVersion: challenge.schemaVersion,
    nonce: challenge.nonce,
    issuerId: challenge.issuerId,
    bridgeId: challenge.bridgeId,
    action: challenge.action,
    componentId: challenge.componentId,
    payloadDigest: challenge.payloadDigest,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  });
}

function safeEnvelopeIdentity(value: unknown): { issuerId: string; bridgeId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { issuerId: 'unknown', bridgeId: 'unknown' };
  const candidate = value as Record<string, unknown>;
  return {
    issuerId: typeof candidate.issuerId === 'string' && IDENTIFIER.test(candidate.issuerId) ? candidate.issuerId : 'unknown',
    bridgeId: typeof candidate.bridgeId === 'string' && IDENTIFIER.test(candidate.bridgeId) ? candidate.bridgeId : 'unknown',
  };
}

function denied(reason: NativeHostAuthenticationReason, identity: { issuerId: string; bridgeId: string }, challenge?: NativeHostChallengeV1): NativeHostAuthenticationDecisionV1 {
  return {
    schemaVersion: NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION,
    allowed: false,
    reason,
    issuerId: identity.issuerId,
    bridgeId: identity.bridgeId,
    action: challenge?.action,
    componentId: challenge?.componentId,
    canExecute: false,
  };
}

/**
 * 原生 bridge 的信任登记。它只保存公钥、精确 caller origin 与最小 action scope；不持有私钥、不验证 OS 签名、不开端口。
 * 平台 adapter 对二进制/OS 进程身份的核验仍是发布门；其结果必须在调用本领域服务前完成。
 */
export class NativeHostBridgeTrustRegistry {
  constructor(private readonly store: NativeHostBridgeTrustStore) {}

  register(input: RegisterNativeHostBridgeInput): NativeHostBridgeTrustManifestV1 {
    assertIdentifier(input.issuerId, 'issuerId');
    assertIdentifier(input.bridgeId, 'bridgeId');
    assertIdentifier(input.keyId, 'keyId');
    if (!TRANSPORTS.has(input.transport)) throw new Error('native host transport 未被支持');
    assertNativeCallerOrigin(input.expectedCallerOrigin);
    assertEpoch(input.at, 'at');
    if (input.allowedActions.length === 0 || input.allowedActions.some((action) => !ACTIONS.has(action)) || new Set(input.allowedActions).size !== input.allowedActions.length) {
      throw new Error('native host allowedActions 必须是非空、无重复的受限构件管理 action');
    }
    if (this.store.load(input.issuerId, input.bridgeId)) throw new Error('native host bridge 已登记');
    const key = createPublicKey(input.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('native host publicKey 必须是 Ed25519 PEM');
    const manifest: NativeHostBridgeTrustManifestV1 = {
      schemaVersion: NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION,
      issuerId: input.issuerId,
      bridgeId: input.bridgeId,
      transport: input.transport,
      expectedCallerOrigin: input.expectedCallerOrigin,
      keyId: input.keyId,
      publicKeyPem: input.publicKeyPem,
      allowedActions: [...input.allowedActions],
      status: 'registered',
      revision: 1,
      registeredAt: input.at,
      updatedAt: input.at,
      canAuthenticateComponentManagement: true,
      canExecute: false,
    };
    this.store.append(manifest);
    return copyManifest(manifest);
  }

  setStatus(issuerId: string, bridgeId: string, status: Exclude<NativeHostTrustStatus, 'registered'>, at: number): NativeHostBridgeTrustManifestV1 {
    assertIdentifier(issuerId, 'issuerId');
    assertIdentifier(bridgeId, 'bridgeId');
    assertEpoch(at, 'at');
    const current = this.store.load(issuerId, bridgeId);
    if (!current) throw new Error('native host bridge 未登记');
    if (current.status === 'revoked') throw new Error('已撤销 native host bridge 不得改变状态；必须登记新的 bridgeId');
    if (current.status === status) throw new Error('native host bridge 已处于目标状态');
    if (status === 'trusted' && current.status !== 'registered' && current.status !== 'disabled') {
      throw new Error('native host bridge 只能从 registered 或 disabled 转为 trusted');
    }
    const next: NativeHostBridgeTrustManifestV1 = { ...current, status, revision: current.revision + 1, updatedAt: at };
    this.store.append(next);
    return copyManifest(next);
  }

  get(issuerId: string, bridgeId: string): NativeHostBridgeTrustManifestV1 | undefined {
    assertIdentifier(issuerId, 'issuerId');
    assertIdentifier(bridgeId, 'bridgeId');
    const manifest = this.store.load(issuerId, bridgeId);
    return manifest ? copyManifest(manifest) : undefined;
  }

  list(): readonly NativeHostBridgeTrustManifestV1[] {
    return this.store.list().map(copyManifest).sort((left, right) => left.issuerId.localeCompare(right.issuerId) || left.bridgeId.localeCompare(right.bridgeId));
  }
}

/** 受信 native host 的单用途 challenge 发放端口；仅能由进程内平台 adapter 调用，未提供 HTTP/renderer 接口。 */
export class NativeHostChallengeIssuer {
  constructor(
    private readonly issuers: TrustedDesktopIssuerRegistry,
    private readonly bridges: NativeHostBridgeTrustRegistry,
    private readonly challenges: NativeHostChallengeStore,
    private readonly now: () => number = Date.now,
    private readonly nonceFactory: () => string = () => randomBytes(32).toString('hex'),
  ) {}

  issue(request: NativeHostChallengeRequest): NativeHostChallengeV1 {
    assertIdentifier(request.issuerId, 'issuerId');
    assertIdentifier(request.bridgeId, 'bridgeId');
    assertIdentifier(request.componentId, 'componentId');
    assertDigest(request.payloadDigest, 'payloadDigest');
    if (!ACTIONS.has(request.action)) throw new Error('component management action 未被支持');
    const issuer = this.issuers.get(request.issuerId);
    if (!issuer || issuer.status !== 'trusted') throw new Error('可信桌面 issuer 未登记、未验证、已停用或已撤销');
    const bridge = this.bridges.get(request.issuerId, request.bridgeId);
    if (!bridge || bridge.status !== 'trusted' || !bridge.allowedActions.includes(request.action)) throw new Error('native host bridge 未受信或不具备此 action scope');
    const nonce = this.nonceFactory();
    if (!NONCE.test(nonce) || this.challenges.load(nonce)) throw new Error('native host nonce 无效或重复');
    const issuedAt = this.now();
    const challenge: NativeHostChallengeV1 = {
      schemaVersion: NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION,
      nonce,
      issuerId: request.issuerId,
      bridgeId: request.bridgeId,
      action: request.action,
      componentId: request.componentId,
      payloadDigest: request.payloadDigest,
      issuedAt,
      expiresAt: issuedAt + MAX_NATIVE_HOST_CHALLENGE_MS,
      canExecute: false,
    };
    this.challenges.append({ schemaVersion: NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION, challenge, state: 'issued', revision: 1, canExecute: false });
    return copyChallenge(challenge);
  }
}

/**
 * 签名/nonce 验证桥。认证成功仅返回受限 `VerifiedComponentManagementAttestationV1`；不安装、加载、激活或执行构件。
 * 一旦收到包含有效 nonce 的 envelope，nonce 即被消费，任何失败也不能重试为成功。
 */
export class NativeHostEnvelopeVerifier {
  constructor(
    private readonly issuers: TrustedDesktopIssuerRegistry,
    private readonly bridges: NativeHostBridgeTrustRegistry,
    private readonly challenges: NativeHostChallengeStore,
    private readonly now: () => number = Date.now,
  ) {}

  verify(value: unknown): NativeHostAuthenticationDecisionV1 {
    const identity = safeEnvelopeIdentity(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return denied('invalid-envelope', identity);
    const envelope = value as Record<string, unknown>;
    if (
      Object.keys(envelope).some((key) => !['schemaVersion', 'nonce', 'issuerId', 'bridgeId', 'callerOrigin', 'keyId', 'signatureBase64'].includes(key))
      || envelope.schemaVersion !== NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION
      || typeof envelope.nonce !== 'string' || !NONCE.test(envelope.nonce)
      || typeof envelope.issuerId !== 'string' || !IDENTIFIER.test(envelope.issuerId)
      || typeof envelope.bridgeId !== 'string' || !IDENTIFIER.test(envelope.bridgeId)
      || typeof envelope.callerOrigin !== 'string' || !ORIGIN.test(envelope.callerOrigin)
      || typeof envelope.keyId !== 'string' || !IDENTIFIER.test(envelope.keyId)
      || typeof envelope.signatureBase64 !== 'string' || envelope.signatureBase64.length === 0 || envelope.signatureBase64.length > 512 || !BASE64.test(envelope.signatureBase64)
    ) return denied('invalid-envelope', identity);

    const record = this.challenges.load(envelope.nonce);
    if (!record) return denied('unknown-challenge', identity);
    const challenge = record.challenge;
    if (record.state !== 'issued') return denied('nonce-consumed', identity, challenge);
    const now = this.now();
    // 先消费 nonce，确保错配或坏签名也不能被重复尝试；append-only store 将保留 verified/rejected 结果。
    const consume = (outcome: NativeHostChallengeOutcome): void => {
      this.challenges.append({
        ...record,
        challenge: copyChallenge(challenge),
        state: 'consumed',
        revision: record.revision + 1,
        consumedAt: now,
        outcome,
        canExecute: false,
      });
    };
    if (now > challenge.expiresAt || now < challenge.issuedAt) {
      consume('rejected');
      return denied('challenge-expired', identity, challenge);
    }
    if (challenge.issuerId !== envelope.issuerId || challenge.bridgeId !== envelope.bridgeId) {
      consume('rejected');
      return denied('challenge-mismatch', identity, challenge);
    }
    const issuer = this.issuers.get(challenge.issuerId);
    if (!issuer || issuer.status !== 'trusted') {
      consume('rejected');
      return denied('issuer-untrusted', identity, challenge);
    }
    const bridge = this.bridges.get(challenge.issuerId, challenge.bridgeId);
    if (!bridge || bridge.status !== 'trusted' || !bridge.allowedActions.includes(challenge.action) || bridge.keyId !== envelope.keyId) {
      consume('rejected');
      return denied('bridge-untrusted', identity, challenge);
    }
    if (bridge.expectedCallerOrigin !== envelope.callerOrigin) {
      consume('rejected');
      return denied('origin-mismatch', identity, challenge);
    }
    let signatureValid = false;
    try {
      signatureValid = verify(null, Buffer.from(canonicalChallengePayload(challenge), 'utf8'), createPublicKey(bridge.publicKeyPem), Buffer.from(envelope.signatureBase64, 'base64'));
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      consume('rejected');
      return denied('signature-invalid', identity, challenge);
    }
    consume('verified');
    const attestation: VerifiedComponentManagementAttestationV1 = {
      schemaVersion: COMPONENT_MANAGEMENT_SCHEMA_VERSION,
      issuerId: challenge.issuerId,
      operationId: `native:${challenge.nonce}`,
      action: challenge.action,
      componentId: challenge.componentId,
      payloadDigest: challenge.payloadDigest,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
    };
    return {
      schemaVersion: NATIVE_HOST_AUTHENTICATION_SCHEMA_VERSION,
      allowed: true,
      reason: 'verified',
      issuerId: challenge.issuerId,
      bridgeId: challenge.bridgeId,
      action: challenge.action,
      componentId: challenge.componentId,
      attestation,
      canExecute: false,
    };
  }
}

/** P6.4 唯一允许进入 P6.3 管理 authority 的受限 native-host adapter；没有 HTTP/renderer 适配器。 */
export class AuthenticatedNativeComponentManagementBridge {
  constructor(
    private readonly challengeIssuer: NativeHostChallengeIssuer,
    private readonly verifier: NativeHostEnvelopeVerifier,
    private readonly management: ComponentManagementAuthority,
  ) {}

  issueChallenge(request: Omit<NativeHostChallengeRequest, 'payloadDigest'> & { payload: ComponentManagementPayload }): NativeHostChallengeV1 {
    return this.challengeIssuer.issue({
      issuerId: request.issuerId,
      bridgeId: request.bridgeId,
      action: request.action,
      componentId: request.componentId,
      payloadDigest: componentManagementPayloadDigest(request.payload),
    });
  }

  manage(envelope: unknown, payload: ComponentManagementPayload): { decision: NativeHostAuthenticationDecisionV1; receipt?: ComponentManagementReceiptV1 } {
    const decision = this.verifier.verify(envelope);
    if (!decision.allowed || !decision.attestation) return { decision };
    const intent: ComponentManagementIntentV1 = {
      schemaVersion: COMPONENT_MANAGEMENT_SCHEMA_VERSION,
      attestation: decision.attestation,
      payload,
    };
    return { decision, receipt: this.management.manage(intent) };
  }
}

export class InMemoryNativeHostBridgeTrustStore implements NativeHostBridgeTrustStore {
  private readonly current = new Map<string, NativeHostBridgeTrustManifestV1>();
  private key(issuerId: string, bridgeId: string): string { return `${issuerId}\u0000${bridgeId}`; }

  load(issuerId: string, bridgeId: string): NativeHostBridgeTrustManifestV1 | undefined {
    const manifest = this.current.get(this.key(issuerId, bridgeId));
    return manifest ? copyManifest(manifest) : undefined;
  }

  append(manifest: NativeHostBridgeTrustManifestV1): void {
    const key = this.key(manifest.issuerId, manifest.bridgeId);
    const current = this.current.get(key);
    if (!current && manifest.revision !== 1) throw new Error('新 native host bridge revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('native host bridge revision 必须严格追加');
    this.current.set(key, copyManifest(manifest));
  }

  list(): readonly NativeHostBridgeTrustManifestV1[] { return [...this.current.values()].map(copyManifest); }
}

export class InMemoryNativeHostChallengeStore implements NativeHostChallengeStore {
  private readonly current = new Map<string, NativeHostChallengeRecordV1>();

  load(nonce: string): NativeHostChallengeRecordV1 | undefined {
    const record = this.current.get(nonce);
    return record ? copyRecord(record) : undefined;
  }

  append(record: NativeHostChallengeRecordV1): void {
    const current = this.current.get(record.challenge.nonce);
    if (!current && (record.revision !== 1 || record.state !== 'issued')) throw new Error('新 native host challenge 必须从 issued revision 1 开始');
    if (current && (record.revision !== current.revision + 1 || current.state !== 'issued' || record.state !== 'consumed')) {
      throw new Error('native host challenge 只能一次性从 issued 追加为 consumed');
    }
    this.current.set(record.challenge.nonce, copyRecord(record));
  }

  list(): readonly NativeHostChallengeRecordV1[] {
    return [...this.current.values()].map(copyRecord).sort((left, right) => right.challenge.issuedAt - left.challenge.issuedAt || left.challenge.nonce.localeCompare(right.challenge.nonce));
  }
}
