import type { NativeHostBridgeTrustRegistry, NativeHostChallengeStore } from '@awo/agent-runtime';

export interface GatewayNativeHostBridgeStatusV1 {
  issuerId: string;
  bridgeId: string;
  transport: 'native-messaging' | 'webview2-isolated-host' | 'desktop-ipc';
  status: 'registered' | 'trusted' | 'disabled' | 'revoked';
  revision: number;
  allowedActions: readonly ('register-candidate' | 'verify-digest' | 'review-provenance' | 'record-lockfile' | 'revoke-provenance')[];
  canAuthenticateComponentManagement: true;
  canExecute: false;
}

export interface GatewayNativeHostAuthenticationReportV1 {
  schemaVersion: 1;
  generatedAt: number;
  bridges: readonly GatewayNativeHostBridgeStatusV1[];
  challengeSummary: { issued: number; consumedVerified: number; consumedRejected: number; };
  browserCanAuthenticate: false;
  canIssueChallenge: false;
  canExecute: false;
}

/** 冷路径认证摘要：故意不返回 origin、公钥、nonce、签名、challenge、payload digest 或任何 host 调用能力。 */
export function createGatewayNativeHostAuthenticationReport(
  bridges: NativeHostBridgeTrustRegistry,
  challenges: NativeHostChallengeStore,
  now: () => number = Date.now,
): GatewayNativeHostAuthenticationReportV1 {
  const records = challenges.list();
  return {
    schemaVersion: 1,
    generatedAt: now(),
    bridges: bridges.list().map((bridge) => ({
      issuerId: bridge.issuerId,
      bridgeId: bridge.bridgeId,
      transport: bridge.transport,
      status: bridge.status,
      revision: bridge.revision,
      allowedActions: [...bridge.allowedActions],
      canAuthenticateComponentManagement: true,
      canExecute: false,
    })),
    challengeSummary: {
      issued: records.filter((record) => record.state === 'issued').length,
      consumedVerified: records.filter((record) => record.state === 'consumed' && record.outcome === 'verified').length,
      consumedRejected: records.filter((record) => record.state === 'consumed' && record.outcome === 'rejected').length,
    },
    browserCanAuthenticate: false,
    canIssueChallenge: false,
    canExecute: false,
  };
}
