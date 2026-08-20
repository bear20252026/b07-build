import {
  SqliteWindowsNativeHostReleaseEvidenceStore,
  WindowsNativeHostReleaseEvidenceLedger,
  WindowsNativeHostReleaseGate,
} from '@awo/agent-runtime';
import { createGatewayWindowsNativeReleaseReport, type GatewayWindowsNativeReleaseReportV1 } from './windows-native-release-report.js';

/** P6.5 Windows-only composition：平台 adapter 才能记录 evidence；HTTP/renderer 只能读取脱敏报告。 */
export interface WindowsNativeReleaseComposition {
  readonly nativeHost: { readonly releaseEvidence: WindowsNativeHostReleaseEvidenceLedger };
  report(): GatewayWindowsNativeReleaseReportV1;
  close(): void;
}

export function createWindowsNativeReleaseComposition(evidencePath: string): WindowsNativeReleaseComposition {
  const store = new SqliteWindowsNativeHostReleaseEvidenceStore(evidencePath);
  const ledger = new WindowsNativeHostReleaseEvidenceLedger(store, new WindowsNativeHostReleaseGate());
  return {
    nativeHost: { releaseEvidence: ledger },
    report: () => createGatewayWindowsNativeReleaseReport(ledger),
    close: () => store.close(),
  };
}
