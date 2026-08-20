import type { WindowsNativeHostReleaseEvidenceLedger } from '@awo/agent-runtime';

export interface GatewayWindowsNativeReleaseEvidenceStatusV1 {
  evidenceId: string;
  platform: 'windows';
  architecture: 'x64' | 'x86' | 'arm64' | 'unknown';
  issuerId: string;
  bridgeId: string;
  helperId: string;
  protocolVersion: string;
  authenticodeStatus: 'valid' | 'not-signed' | 'invalid' | 'unknown';
  capturedAt: number;
  canExecute: false;
  canAutoTrust: false;
}

export interface GatewayWindowsNativeReleaseReportV1 {
  schemaVersion: 1;
  generatedAt: number;
  platform: 'windows';
  evidences: readonly GatewayWindowsNativeReleaseEvidenceStatusV1[];
  windowsOnly: true;
  browserCanCaptureEvidence: false;
  canRegisterBridge: false;
  canTrustBridge: false;
  canExecute: false;
}

/** Windows-only 冷路径发布摘要；故意不返回 SHA-256、signer thumbprint digest、路径、证书、签名或 release-gate expectation。 */
export function createGatewayWindowsNativeReleaseReport(
  ledger: WindowsNativeHostReleaseEvidenceLedger,
  now: () => number = Date.now,
): GatewayWindowsNativeReleaseReportV1 {
  return {
    schemaVersion: 1,
    generatedAt: now(),
    platform: 'windows',
    evidences: ledger.list().map((evidence) => ({
      evidenceId: evidence.evidenceId,
      platform: evidence.platform,
      architecture: evidence.architecture,
      issuerId: evidence.issuerId,
      bridgeId: evidence.bridgeId,
      helperId: evidence.helperId,
      protocolVersion: evidence.protocolVersion,
      authenticodeStatus: evidence.authenticodeStatus,
      capturedAt: evidence.capturedAt,
      canExecute: false,
      canAutoTrust: false,
    })),
    windowsOnly: true,
    browserCanCaptureEvidence: false,
    canRegisterBridge: false,
    canTrustBridge: false,
    canExecute: false,
  };
}
