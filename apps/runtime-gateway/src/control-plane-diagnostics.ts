import type {
  ExtensionDoctor,
  ExtensionRegistry,
  TrustedDesktopIssuerRegistry,
} from '@awo/agent-runtime';
import type { SkillPackRegistry } from '@awo/knowledge-workflow';
import type { LocalModelHealthRegistry, ProviderProfileRegistry } from '@awo/provider-sdk';
import type { Capability } from '@awo/protocol';

export const CONTROL_PLANE_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export interface ControlPlaneDiagnosticReportV1 {
  schemaVersion: typeof CONTROL_PLANE_DIAGNOSTIC_SCHEMA_VERSION;
  generatedAt: number;
  authority: Readonly<{
    adminIssuance: 'trusted-desktop-host-required';
    browserCanIssue: false;
    canExecute: false;
  }>;
  extensions: readonly Readonly<{
    id: string;
    kind: string;
    status: string;
    revision: number;
    dataBoundary: string;
    declaredCapabilities: readonly Capability[];
    findings: readonly Readonly<{ severity: 'info' | 'warning'; code: string }>[];
    canExecute: false;
  }>[];
  skillPacks: readonly Readonly<{
    id: string;
    status: string;
    revision: number;
    version: string;
    estimatedTokens: number;
    canAuthorize: false;
    canGrantCapabilities: false;
  }>[];
  providers: readonly Readonly<{
    id: string;
    status: string;
    revision: number;
    dataBoundary: string;
    driverIds: readonly string[];
  }>[];
  localModels: readonly Readonly<{
    id: string;
    configuredModelId: string;
    offline: boolean;
    healthStatus: 'unknown' | 'healthy' | 'unhealthy';
    checkedAt?: number;
    modelIds: readonly string[];
  }>[];
  trustedDesktopIssuers: readonly Readonly<{
    issuerId: string;
    displayName: string;
    platform: string;
    status: string;
    revision: number;
    canExecute: false;
  }>[];
  canExecute: false;
}

export interface ControlPlaneDiagnosticSources {
  readonly extensions: ExtensionRegistry;
  readonly extensionDoctor: ExtensionDoctor;
  readonly skillPacks: SkillPackRegistry;
  readonly providerProfiles: ProviderProfileRegistry;
  readonly localModels: LocalModelHealthRegistry;
  readonly trustedDesktopIssuers: TrustedDesktopIssuerRegistry;
  readonly now?: () => number;
}

/**
 * 冷路径诊断投影。禁止调用任何 plan/activate/probe/connect/run/spawn/issue 方法；
 * 仅消费已经存在的 manifest、profile、health 和 issuer metadata。
 */
export function createControlPlaneDiagnosticReport(sources: ControlPlaneDiagnosticSources): ControlPlaneDiagnosticReportV1 {
  const extensionFindings = new Map<string, Readonly<{ severity: 'info' | 'warning'; code: string }>[]>() ;
  for (const finding of sources.extensionDoctor.inspect()) {
    const current = extensionFindings.get(finding.extensionId) ?? [];
    extensionFindings.set(finding.extensionId, [...current, { severity: finding.severity, code: finding.code }]);
  }
  return {
    schemaVersion: CONTROL_PLANE_DIAGNOSTIC_SCHEMA_VERSION,
    generatedAt: (sources.now ?? Date.now)(),
    authority: { adminIssuance: 'trusted-desktop-host-required', browserCanIssue: false, canExecute: false },
    extensions: sources.extensions.list().map((manifest) => ({
      id: manifest.id,
      kind: manifest.kind,
      status: manifest.status,
      revision: manifest.revision,
      dataBoundary: manifest.dataBoundary,
      declaredCapabilities: [...manifest.declaredCapabilities],
      findings: [...(extensionFindings.get(manifest.id) ?? [])].sort((left, right) => left.code.localeCompare(right.code)),
      canExecute: false as const,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    skillPacks: sources.skillPacks.list().map((manifest) => ({
      id: manifest.id,
      status: manifest.status,
      revision: manifest.revision,
      version: manifest.version,
      estimatedTokens: manifest.estimatedTokens,
      canAuthorize: false as const,
      canGrantCapabilities: false as const,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    providers: sources.providerProfiles.list().map((profile) => ({
      id: profile.id,
      status: profile.status,
      revision: profile.revision,
      dataBoundary: profile.maximumDataBoundary,
      driverIds: [...profile.driverIds].sort(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    localModels: sources.localModels.listHealth().map((model) => ({
      id: model.id,
      configuredModelId: model.configuredModelId,
      offline: model.offline,
      healthStatus: model.health.status,
      checkedAt: model.health.checkedAt,
      modelIds: [...model.health.modelIds].sort(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    trustedDesktopIssuers: sources.trustedDesktopIssuers.list().map((issuer) => ({
      issuerId: issuer.issuerId,
      displayName: issuer.displayName,
      platform: issuer.platform,
      status: issuer.status,
      revision: issuer.revision,
      canExecute: false as const,
    })).sort((left, right) => left.issuerId.localeCompare(right.issuerId)),
    canExecute: false,
  };
}
