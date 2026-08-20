import {
  ExtensionDoctor,
  ExtensionRegistry,
  SecurityPostureAuditService,
  TrustedDesktopIssuerRegistry,
  type SecurityPostureReportV1,
} from '@awo/agent-runtime';
import type { LocalModelHealthRegistry, ProviderProfileRegistry } from '@awo/provider-sdk';

export interface GatewaySecurityPostureAuditSources {
  readonly extensions: ExtensionRegistry;
  readonly extensionDoctor: ExtensionDoctor;
  readonly providerProfiles: ProviderProfileRegistry;
  readonly localModels: LocalModelHealthRegistry;
  readonly trustedDesktopIssuers: TrustedDesktopIssuerRegistry;
  /** 只能由未来恢复控制面提供已完成演练的摘要；未提供即产生 warning，绝不触发演练。 */
  readonly recoveryEvidence?: Readonly<{ latestDrillAt?: number; quickCheckOk: boolean }>;
  /** 只能由 Rust/宿主提供状态摘要；审计不会尝试创建 cgroup 或修改进程。 */
  readonly resourceIsolationEvidence?: Readonly<{ requested: boolean; enforced: boolean }>;
  readonly now?: () => number;
}

/**
 * Gateway 冷路径安全审计：只投影已经注册的控制面状态。
 * 若 audit evidence 缺失则以 finding 表达，绝不通过 probe、修复、启动或签发来“补齐”证据。
 */
export function createGatewaySecurityPostureReport(sources: GatewaySecurityPostureAuditSources): SecurityPostureReportV1 {
  const doctorFindings = new Map<string, string[]>();
  for (const finding of sources.extensionDoctor.inspect()) {
    const current = doctorFindings.get(finding.extensionId) ?? [];
    doctorFindings.set(finding.extensionId, [...current, finding.code]);
  }
  return new SecurityPostureAuditService().inspect({
    schemaVersion: 1,
    // P6.0 由 RecoverableTaskRuntime 在 Profile/Authority 后固定装配；本审计只声明该已验证产品接缝。
    taintGateEnforced: true,
    extensions: sources.extensions.list().map((extension) => ({
      id: extension.id,
      status: extension.status,
      findingCodes: [...(doctorFindings.get(extension.id) ?? [])].sort(),
    })),
    providers: sources.providerProfiles.list().map((provider) => ({
      id: provider.id,
      status: provider.status,
      dataBoundary: provider.maximumDataBoundary,
    })),
    localModels: sources.localModels.listHealth().map((model) => ({
      id: model.id,
      offline: model.offline,
      healthStatus: model.health.status,
    })),
    trustedDesktopIssuers: sources.trustedDesktopIssuers.list().map((issuer) => ({
      issuerId: issuer.issuerId,
      status: issuer.status,
    })),
    recovery: sources.recoveryEvidence ?? { quickCheckOk: false },
    resourceIsolation: sources.resourceIsolationEvidence ?? { requested: false, enforced: false },
  }, (sources.now ?? Date.now)());
}
