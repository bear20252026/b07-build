import { createHash } from 'node:crypto';
import {
  ComponentLockfileLedger,
  ComponentProvenanceRegistry,
  createComponentLockfile,
  provenanceDigest,
  type ComponentLockEntryV1,
  type RegisterComponentCandidateRequest,
} from './component-provenance.js';
import { TrustedDesktopIssuerRegistry } from './trusted-desktop-issuer.js';

export const COMPONENT_MANAGEMENT_SCHEMA_VERSION = 1 as const;
export const MAX_COMPONENT_MANAGEMENT_ATTESTATION_MS = 5 * 60_000;

export type ComponentManagementAction = 'register-candidate' | 'verify-digest' | 'review-provenance' | 'record-lockfile' | 'revoke-provenance';
export type ComponentManagementOutcome = 'applied' | 'rejected';
export type ComponentManagementRejectionCode =
  | 'attestation-invalid'
  | 'attestation-expired'
  | 'issuer-untrusted'
  | 'operation-replayed'
  | 'payload-mismatch'
  | 'precondition-failed';

/**
 * future native host 已完成本机身份认证后才能传入的、单用途 attestation metadata。
 * 它不是 renderer、HTTP header 或浏览器声明；本服务不替代 OS/native 签名验证。
 */
export interface VerifiedComponentManagementAttestationV1 {
  schemaVersion: typeof COMPONENT_MANAGEMENT_SCHEMA_VERSION;
  issuerId: string;
  operationId: string;
  action: ComponentManagementAction;
  componentId: string;
  payloadDigest: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RegisterComponentCandidatePayload extends RegisterComponentCandidateRequest {}
export interface VerifyComponentDigestPayload { componentId: string; expectedDigest: string; }
export interface ReviewComponentProvenancePayload { componentId: string; reviewer: string; expectedDigest: string; }
/** 由可信宿主显式列出全部待锁定的 component ID；服务不会扫 registry 自动补齐或升级。 */
export interface RecordComponentLockfilePayload { componentIds: readonly string[]; }
export interface RevokeComponentProvenancePayload { componentId: string; }

export type ComponentManagementPayload =
  | RegisterComponentCandidatePayload
  | VerifyComponentDigestPayload
  | ReviewComponentProvenancePayload
  | RecordComponentLockfilePayload
  | RevokeComponentProvenancePayload;

export interface ComponentManagementIntentV1 {
  schemaVersion: typeof COMPONENT_MANAGEMENT_SCHEMA_VERSION;
  attestation: VerifiedComponentManagementAttestationV1;
  payload: ComponentManagementPayload;
}

export interface ComponentManagementReceiptV1 {
  schemaVersion: typeof COMPONENT_MANAGEMENT_SCHEMA_VERSION;
  operationId: string;
  issuerId: string;
  action: ComponentManagementAction;
  componentId: string;
  payloadDigest: string;
  outcome: ComponentManagementOutcome;
  rejectionCode?: ComponentManagementRejectionCode;
  recordedAt: number;
  canExecute: false;
  canAutoRemediate: false;
}

export interface ComponentManagementReceiptStore {
  load(operationId: string): ComponentManagementReceiptV1 | undefined;
  append(receipt: ComponentManagementReceiptV1): void;
  list(componentId?: string): readonly ComponentManagementReceiptV1[];
  close?(): void;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ACTIONS = new Set<ComponentManagementAction>(['register-candidate', 'verify-digest', 'review-provenance', 'record-lockfile', 'revoke-provenance']);

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** P6.3/P6.4 共用的 payload 摘要：仅约束受限 metadata，永不接受或保存构件文件、路径、URL、凭据或命令。 */
export function componentManagementPayloadDigest(payload: ComponentManagementPayload): string {
  return canonicalDigest(intentPayloadForDigest(payload));
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} 必须是小写 SHA-256 十六进制摘要`);
}

function copyReceipt(receipt: ComponentManagementReceiptV1): ComponentManagementReceiptV1 {
  return { ...receipt };
}

function assertAttestation(attestation: VerifiedComponentManagementAttestationV1, now: number): void {
  if (attestation.schemaVersion !== COMPONENT_MANAGEMENT_SCHEMA_VERSION) throw new Error('Component Management attestation 版本不兼容');
  assertIdentifier(attestation.issuerId, 'attestation.issuerId');
  assertIdentifier(attestation.operationId, 'attestation.operationId');
  assertIdentifier(attestation.componentId, 'attestation.componentId');
  if (!ACTIONS.has(attestation.action)) throw new Error('attestation.action 未被支持');
  assertDigest(attestation.payloadDigest, 'attestation.payloadDigest');
  assertEpoch(attestation.issuedAt, 'attestation.issuedAt');
  assertEpoch(attestation.expiresAt, 'attestation.expiresAt');
  if (attestation.expiresAt <= attestation.issuedAt || attestation.expiresAt - attestation.issuedAt > MAX_COMPONENT_MANAGEMENT_ATTESTATION_MS) {
    throw new Error(`Component Management attestation 有效期必须为 1-${MAX_COMPONENT_MANAGEMENT_ATTESTATION_MS}ms`);
  }
  if (Math.abs(now - attestation.issuedAt) > 60_000 || now > attestation.expiresAt) throw new Error('Component Management attestation 已过期或宿主时钟偏差过大');
}

function intentPayloadForDigest(payload: ComponentManagementPayload): unknown {
  if ('componentIds' in payload) return { componentIds: [...payload.componentIds] };
  return { ...payload };
}

function actionMatchesPayload(action: ComponentManagementAction, payload: ComponentManagementPayload): boolean {
  if (action === 'register-candidate') return 'componentKind' in payload && 'sourceRef' in payload;
  if (action === 'verify-digest') return 'expectedDigest' in payload && !('reviewer' in payload);
  if (action === 'review-provenance') return 'expectedDigest' in payload && 'reviewer' in payload;
  if (action === 'record-lockfile') return 'componentIds' in payload;
  return action === 'revoke-provenance' && 'componentId' in payload && !('expectedDigest' in payload);
}

/**
 * P6.3 本地宿主专用管理端口。它不提供 HTTP、浏览器入口、下载、文件扫描、哈希计算、安装、加载、网络连接或自动升级。
 * 调用者必须是已完成本机认证的 native host，并以单次 attestation 绑定动作、构件与请求摘要。
 */
export class ComponentManagementAuthority {
  constructor(
    private readonly issuers: TrustedDesktopIssuerRegistry,
    private readonly provenances: ComponentProvenanceRegistry,
    private readonly lockfiles: ComponentLockfileLedger,
    private readonly receipts: ComponentManagementReceiptStore,
    private readonly now: () => number = Date.now,
  ) {}

  manage(intent: ComponentManagementIntentV1): ComponentManagementReceiptV1 {
    const now = this.now();
    const attestation = intent.attestation;
    // 不接受语法不可识别的输入：无法安全形成固定审计 key 时宁可直接失败关闭。
    assertIdentifier(attestation.operationId, 'attestation.operationId');
    if (this.receipts.load(attestation.operationId)) throw new Error('Component Management operationId 已处理；重放被拒绝');

    const requestDigest = componentManagementPayloadDigest(intent.payload);
    let rejectionCode: ComponentManagementRejectionCode | undefined;
    try {
      if (intent.schemaVersion !== COMPONENT_MANAGEMENT_SCHEMA_VERSION) throw new Error('Component Management intent 版本不兼容');
      assertAttestation(attestation, now);
      if (!actionMatchesPayload(attestation.action, intent.payload)) throw new Error('attestation action 与 payload 不匹配');
      if (attestation.payloadDigest !== requestDigest) throw new Error('attestation payloadDigest 不匹配');
      const issuer = this.issuers.get(attestation.issuerId);
      if (!issuer || issuer.status !== 'trusted') throw new Error('可信桌面 issuer 未登记、未验证、已停用或已撤销');
      this.apply(attestation, intent.payload, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      rejectionCode = message.includes('过期') || message.includes('时钟偏差') ? 'attestation-expired'
        : message.includes('issuer') ? 'issuer-untrusted'
          : message.includes('payload') || message.includes('action') ? 'payload-mismatch'
            : message.includes('attestation') ? 'attestation-invalid'
              : 'precondition-failed';
    }
    const receipt: ComponentManagementReceiptV1 = {
      schemaVersion: COMPONENT_MANAGEMENT_SCHEMA_VERSION,
      operationId: attestation.operationId,
      issuerId: attestation.issuerId,
      action: attestation.action,
      componentId: attestation.componentId,
      payloadDigest: requestDigest,
      outcome: rejectionCode ? 'rejected' : 'applied',
      rejectionCode,
      recordedAt: now,
      canExecute: false,
      canAutoRemediate: false,
    };
    this.receipts.append(receipt);
    return copyReceipt(receipt);
  }

  listReceipts(componentId?: string): readonly ComponentManagementReceiptV1[] {
    if (componentId !== undefined) assertIdentifier(componentId, 'componentId');
    return this.receipts.list(componentId).map(copyReceipt).sort((left, right) => right.recordedAt - left.recordedAt || left.operationId.localeCompare(right.operationId));
  }

  private apply(attestation: VerifiedComponentManagementAttestationV1, payload: ComponentManagementPayload, now: number): void {
    if (attestation.action === 'register-candidate') {
      const candidate = payload as RegisterComponentCandidatePayload;
      if (candidate.componentId !== attestation.componentId) throw new Error('candidate componentId 与 attestation 不匹配');
      this.provenances.registerCandidate({ ...candidate, at: now });
      return;
    }
    if (attestation.action === 'verify-digest') {
      const verification = payload as VerifyComponentDigestPayload;
      if (verification.componentId !== attestation.componentId) throw new Error('digest verification componentId 与 attestation 不匹配');
      assertDigest(verification.expectedDigest, 'expectedDigest');
      const current = this.provenances.list().find((item) => item.componentId === verification.componentId);
      if (!current || current.contentDigest !== verification.expectedDigest) throw new Error('已登记 provenance 与宿主已核验摘要不一致');
      return;
    }
    if (attestation.action === 'review-provenance') {
      const review = payload as ReviewComponentProvenancePayload;
      if (review.componentId !== attestation.componentId) throw new Error('review componentId 与 attestation 不匹配');
      const verification = this.receipts.list(review.componentId).some((receipt) => receipt.action === 'verify-digest' && receipt.outcome === 'applied' && receipt.payloadDigest === canonicalDigest({ componentId: review.componentId, expectedDigest: review.expectedDigest }));
      if (!verification) throw new Error('评审前必须有同一摘要的已核验宿主回执');
      this.provenances.review(review.componentId, review.reviewer, now, review.expectedDigest);
      return;
    }
    if (attestation.action === 'record-lockfile') {
      const lockRequest = payload as RecordComponentLockfilePayload;
      if (attestation.componentId !== 'component-lockfile') throw new Error('lockfile attestation 必须绑定 component-lockfile');
      if (lockRequest.componentIds.length === 0 || lockRequest.componentIds.length > 512 || new Set(lockRequest.componentIds).size !== lockRequest.componentIds.length) {
        throw new Error('lockfile 必须显式列出 1-512 个不重复 componentId');
      }
      const byId = new Map(this.provenances.list().map((item) => [item.componentId, item]));
      const entries: ComponentLockEntryV1[] = lockRequest.componentIds.map((componentId) => {
        assertIdentifier(componentId, 'lockfile.componentId');
        const provenance = byId.get(componentId);
        if (!provenance || provenance.reviewStatus !== 'reviewed') throw new Error('lockfile 只能包含当前 reviewed provenance');
        return { componentId, contentDigest: provenance.contentDigest, provenanceDigest: provenanceDigest(provenance) };
      });
      const revision = (this.lockfiles.latest()?.revision ?? 0) + 1;
      this.lockfiles.record(createComponentLockfile(revision, entries, now));
      return;
    }
    const revocation = payload as RevokeComponentProvenancePayload;
    if (revocation.componentId !== attestation.componentId) throw new Error('revoke componentId 与 attestation 不匹配');
    this.provenances.revoke(revocation.componentId, now);
  }
}

export class InMemoryComponentManagementReceiptStore implements ComponentManagementReceiptStore {
  private readonly receipts = new Map<string, ComponentManagementReceiptV1>();

  load(operationId: string): ComponentManagementReceiptV1 | undefined {
    assertIdentifier(operationId, 'operationId');
    const receipt = this.receipts.get(operationId);
    return receipt ? copyReceipt(receipt) : undefined;
  }

  append(receipt: ComponentManagementReceiptV1): void {
    assertIdentifier(receipt.operationId, 'operationId');
    if (this.receipts.has(receipt.operationId)) throw new Error('Component Management operationId 不可重复追加');
    this.receipts.set(receipt.operationId, copyReceipt(receipt));
  }

  list(componentId?: string): readonly ComponentManagementReceiptV1[] {
    if (componentId !== undefined) assertIdentifier(componentId, 'componentId');
    return [...this.receipts.values()]
      .filter((receipt) => componentId === undefined || receipt.componentId === componentId)
      .map(copyReceipt);
  }
}
