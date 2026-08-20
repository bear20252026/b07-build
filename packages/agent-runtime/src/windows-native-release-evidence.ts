export const WINDOWS_NATIVE_HOST_RELEASE_SCHEMA_VERSION = 1 as const;
export const MAX_WINDOWS_RELEASE_EVIDENCE_AGE_MS = 24 * 60 * 60_000;

export type WindowsArchitecture = 'x64' | 'x86' | 'arm64' | 'unknown';
export type WindowsAuthenticodeStatus = 'valid' | 'not-signed' | 'invalid' | 'unknown';
export type WindowsReleaseDecisionStatus = 'release-ready' | 'rejected';
export type WindowsReleaseRejectionCode =
  | 'platform-not-windows'
  | 'architecture-not-x64'
  | 'authenticode-not-valid'
  | 'binary-digest-mismatch'
  | 'signer-digest-mismatch'
  | 'protocol-version-mismatch'
  | 'identity-mismatch'
  | 'evidence-expired'
  | 'evidence-invalid';

/**
 * 由 Windows native adapter 在本机以固定、无 profile、非交互的 Authenticode/Hash 安全读取采集。
 * 该 DTO 永不携带 helper 路径、文件名、证书 subject/正文、私钥、签名 blob、PowerShell 输出或命令。
 */
export interface WindowsNativeHostReleaseEvidenceV1 {
  schemaVersion: typeof WINDOWS_NATIVE_HOST_RELEASE_SCHEMA_VERSION;
  evidenceId: string;
  platform: 'windows';
  architecture: WindowsArchitecture;
  issuerId: string;
  bridgeId: string;
  helperId: string;
  protocolVersion: string;
  binaryDigest: string;
  signerThumbprintDigest: string;
  authenticodeStatus: WindowsAuthenticodeStatus;
  capturedAt: number;
  canExecute: false;
  canAutoTrust: false;
}

export interface WindowsNativeHostReleaseExpectationV1 {
  issuerId: string;
  bridgeId: string;
  helperId: string;
  protocolVersion: string;
  expectedBinaryDigest: string;
  expectedSignerThumbprintDigest: string;
  maxEvidenceAgeMs: number;
}

export interface WindowsNativeHostReleaseDecisionV1 {
  schemaVersion: typeof WINDOWS_NATIVE_HOST_RELEASE_SCHEMA_VERSION;
  evidenceId: string;
  issuerId: string;
  bridgeId: string;
  helperId: string;
  status: WindowsReleaseDecisionStatus;
  rejectionCodes: readonly WindowsReleaseRejectionCode[];
  canRegisterBridge: false;
  canTrustBridge: false;
  canExecute: false;
}

export interface WindowsNativeHostReleaseEvidenceStore {
  load(evidenceId: string): WindowsNativeHostReleaseEvidenceV1 | undefined;
  append(evidence: WindowsNativeHostReleaseEvidenceV1): void;
  list(issuerId?: string, bridgeId?: string): readonly WindowsNativeHostReleaseEvidenceV1[];
  close?(): void;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PROTOCOL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARCHITECTURES = new Set<WindowsArchitecture>(['x64', 'x86', 'arm64', 'unknown']);
const AUTHENTICODE_STATUSES = new Set<WindowsAuthenticodeStatus>(['valid', 'not-signed', 'invalid', 'unknown']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} 必须是小写 SHA-256 十六进制摘要`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertProtocol(value: string, label: string): void {
  if (!PROTOCOL.test(value)) throw new Error(`${label} 必须是 1-128 位安全协议版本标识`);
}

function copyEvidence(evidence: WindowsNativeHostReleaseEvidenceV1): WindowsNativeHostReleaseEvidenceV1 {
  return { ...evidence };
}

function copyDecision(decision: WindowsNativeHostReleaseDecisionV1): WindowsNativeHostReleaseDecisionV1 {
  return { ...decision, rejectionCodes: [...decision.rejectionCodes] };
}

/**
 * Windows-only evidence verifier。它不读取文件、不启动 PowerShell、不验证证书链、不操作 bridge registry；
 * 平台 adapter 必须在本机完成受限读取后传入脱敏 facts，本类只对受控期望执行 fail-closed 比对。
 */
export class WindowsNativeHostReleaseGate {
  constructor(private readonly now: () => number = Date.now) {}

  inspect(evidence: WindowsNativeHostReleaseEvidenceV1, expected: WindowsNativeHostReleaseExpectationV1): WindowsNativeHostReleaseDecisionV1 {
    const isValid = this.validate(evidence, expected);
    if (!isValid) return this.rejected(evidence, ['evidence-invalid']);
    const rejectionCodes: WindowsReleaseRejectionCode[] = [];
    if (evidence.platform !== 'windows') rejectionCodes.push('platform-not-windows');
    if (evidence.architecture !== 'x64') rejectionCodes.push('architecture-not-x64');
    if (evidence.authenticodeStatus !== 'valid') rejectionCodes.push('authenticode-not-valid');
    if (evidence.issuerId !== expected.issuerId || evidence.bridgeId !== expected.bridgeId || evidence.helperId !== expected.helperId) rejectionCodes.push('identity-mismatch');
    if (evidence.protocolVersion !== expected.protocolVersion) rejectionCodes.push('protocol-version-mismatch');
    if (evidence.binaryDigest !== expected.expectedBinaryDigest) rejectionCodes.push('binary-digest-mismatch');
    if (evidence.signerThumbprintDigest !== expected.expectedSignerThumbprintDigest) rejectionCodes.push('signer-digest-mismatch');
    if (this.now() < evidence.capturedAt || this.now() - evidence.capturedAt > expected.maxEvidenceAgeMs) rejectionCodes.push('evidence-expired');
    return rejectionCodes.length === 0
      ? {
          schemaVersion: WINDOWS_NATIVE_HOST_RELEASE_SCHEMA_VERSION,
          evidenceId: evidence.evidenceId,
          issuerId: evidence.issuerId,
          bridgeId: evidence.bridgeId,
          helperId: evidence.helperId,
          status: 'release-ready',
          rejectionCodes: [],
          canRegisterBridge: false,
          canTrustBridge: false,
          canExecute: false,
        }
      : this.rejected(evidence, rejectionCodes);
  }

  private validate(evidence: WindowsNativeHostReleaseEvidenceV1, expected: WindowsNativeHostReleaseExpectationV1): boolean {
    try {
      if (evidence.schemaVersion !== WINDOWS_NATIVE_HOST_RELEASE_SCHEMA_VERSION) return false;
      assertIdentifier(evidence.evidenceId, 'evidenceId');
      assertIdentifier(evidence.issuerId, 'issuerId');
      assertIdentifier(evidence.bridgeId, 'bridgeId');
      assertIdentifier(evidence.helperId, 'helperId');
      assertProtocol(evidence.protocolVersion, 'protocolVersion');
      assertDigest(evidence.binaryDigest, 'binaryDigest');
      assertDigest(evidence.signerThumbprintDigest, 'signerThumbprintDigest');
      assertEpoch(evidence.capturedAt, 'capturedAt');
      if (evidence.platform !== 'windows' || !ARCHITECTURES.has(evidence.architecture) || !AUTHENTICODE_STATUSES.has(evidence.authenticodeStatus) || evidence.canExecute !== false || evidence.canAutoTrust !== false) return false;
      assertIdentifier(expected.issuerId, 'expected.issuerId');
      assertIdentifier(expected.bridgeId, 'expected.bridgeId');
      assertIdentifier(expected.helperId, 'expected.helperId');
      assertProtocol(expected.protocolVersion, 'expected.protocolVersion');
      assertDigest(expected.expectedBinaryDigest, 'expected.expectedBinaryDigest');
      assertDigest(expected.expectedSignerThumbprintDigest, 'expected.expectedSignerThumbprintDigest');
      if (!Number.isSafeInteger(expected.maxEvidenceAgeMs) || expected.maxEvidenceAgeMs < 1 || expected.maxEvidenceAgeMs > MAX_WINDOWS_RELEASE_EVIDENCE_AGE_MS) return false;
      return true;
    } catch {
      return false;
    }
  }

  private rejected(evidence: WindowsNativeHostReleaseEvidenceV1, rejectionCodes: readonly WindowsReleaseRejectionCode[]): WindowsNativeHostReleaseDecisionV1 {
    return {
      schemaVersion: WINDOWS_NATIVE_HOST_RELEASE_SCHEMA_VERSION,
      evidenceId: evidence.evidenceId,
      issuerId: evidence.issuerId,
      bridgeId: evidence.bridgeId,
      helperId: evidence.helperId,
      status: 'rejected',
      rejectionCodes: [...new Set(rejectionCodes)].sort(),
      canRegisterBridge: false,
      canTrustBridge: false,
      canExecute: false,
    };
  }
}

/** Windows native adapter 将证据显式写入 append-only 账本后才能获得审计决定；结果不触发任何 bridge 状态变更。 */
export class WindowsNativeHostReleaseEvidenceLedger {
  constructor(private readonly store: WindowsNativeHostReleaseEvidenceStore, private readonly gate: WindowsNativeHostReleaseGate) {}

  record(evidence: WindowsNativeHostReleaseEvidenceV1, expected: WindowsNativeHostReleaseExpectationV1): WindowsNativeHostReleaseDecisionV1 {
    if (this.store.load(evidence.evidenceId)) throw new Error('Windows release evidenceId 不可重放或覆盖');
    this.store.append(evidence);
    return copyDecision(this.gate.inspect(evidence, expected));
  }

  list(issuerId?: string, bridgeId?: string): readonly WindowsNativeHostReleaseEvidenceV1[] {
    if (issuerId !== undefined) assertIdentifier(issuerId, 'issuerId');
    if (bridgeId !== undefined) assertIdentifier(bridgeId, 'bridgeId');
    return this.store.list(issuerId, bridgeId).map(copyEvidence).sort((left, right) => right.capturedAt - left.capturedAt || left.evidenceId.localeCompare(right.evidenceId));
  }
}

export class InMemoryWindowsNativeHostReleaseEvidenceStore implements WindowsNativeHostReleaseEvidenceStore {
  private readonly evidences = new Map<string, WindowsNativeHostReleaseEvidenceV1>();

  load(evidenceId: string): WindowsNativeHostReleaseEvidenceV1 | undefined {
    assertIdentifier(evidenceId, 'evidenceId');
    const evidence = this.evidences.get(evidenceId);
    return evidence ? copyEvidence(evidence) : undefined;
  }

  append(evidence: WindowsNativeHostReleaseEvidenceV1): void {
    assertIdentifier(evidence.evidenceId, 'evidenceId');
    if (this.evidences.has(evidence.evidenceId)) throw new Error('Windows release evidence 不可重复追加');
    this.evidences.set(evidence.evidenceId, copyEvidence(evidence));
  }

  list(issuerId?: string, bridgeId?: string): readonly WindowsNativeHostReleaseEvidenceV1[] {
    if (issuerId !== undefined) assertIdentifier(issuerId, 'issuerId');
    if (bridgeId !== undefined) assertIdentifier(bridgeId, 'bridgeId');
    return [...this.evidences.values()]
      .filter((evidence) => (issuerId === undefined || evidence.issuerId === issuerId) && (bridgeId === undefined || evidence.bridgeId === bridgeId))
      .map(copyEvidence);
  }
}
