import type { ComponentManagementAuthority, ComponentManagementRejectionCode } from '@awo/agent-runtime';

export interface GatewayComponentManagementReceiptV1 {
  operationId: string;
  issuerId: string;
  action: 'register-candidate' | 'verify-digest' | 'review-provenance' | 'record-lockfile' | 'revoke-provenance';
  componentId: string;
  outcome: 'applied' | 'rejected';
  rejectionCode?: ComponentManagementRejectionCode;
  recordedAt: number;
  canExecute: false;
  canAutoRemediate: false;
}

export interface GatewayComponentManagementReportV1 {
  schemaVersion: 1;
  generatedAt: number;
  receipts: readonly GatewayComponentManagementReceiptV1[];
  browserCanManage: false;
  canExecute: false;
  canAutoRemediate: false;
}

/** 冷路径审计投影：故意不暴露 attestation payload digest、来源、路径、许可证、制品或任何 native-host 控制句柄。 */
export function createGatewayComponentManagementReport(
  management: ComponentManagementAuthority,
  now: () => number = Date.now,
): GatewayComponentManagementReportV1 {
  return {
    schemaVersion: 1,
    generatedAt: now(),
    receipts: management.listReceipts().map((receipt) => ({
      operationId: receipt.operationId,
      issuerId: receipt.issuerId,
      action: receipt.action,
      componentId: receipt.componentId,
      outcome: receipt.outcome,
      rejectionCode: receipt.rejectionCode,
      recordedAt: receipt.recordedAt,
      canExecute: false,
      canAutoRemediate: false,
    })),
    browserCanManage: false,
    canExecute: false,
    canAutoRemediate: false,
  };
}
