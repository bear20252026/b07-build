import {
  ComponentLockEnforcementService,
  ComponentLockfileLedger,
  ComponentProvenanceRegistry,
  type ComponentEligibilityDecisionV1,
  type ExtensionManifest,
  type ExtensionProvenanceLockGuard,
} from '@awo/agent-runtime';
import type { AgentAdapterControlPlane, ExtensionRegistry } from '@awo/agent-runtime';
import type { SkillPackRegistry } from '@awo/knowledge-workflow';

export interface GatewayComponentLockReportV1 {
  schemaVersion: 1;
  inspectedAt: number;
  lockfile: Readonly<{ revision: number; lockDigest: string }> | undefined;
  decisions: readonly ComponentEligibilityDecisionV1[];
  canActivate: false;
  canAutoRepair: false;
}

export interface GatewayComponentLockSources {
  readonly extensions: ExtensionRegistry;
  readonly skillPacks: SkillPackRegistry;
  readonly agentAdapters: AgentAdapterControlPlane;
  readonly provenances: ComponentProvenanceRegistry;
  readonly lockfiles: ComponentLockfileLedger;
  readonly now?: () => number;
}

function extensionObservations(manifests: readonly ExtensionManifest[]) {
  return manifests
    .filter((manifest) => manifest.status === 'installed')
    .map((manifest) => ({ componentId: manifest.id, componentKind: 'extension' as const, version: manifest.version, contentDigest: manifest.source.digest.toLowerCase() }));
}

/** P6.2 与既有 planner 的唯一接缝：只传回 quarantine reason，planner 仍不加载任何构件。 */
export function createGatewayExtensionProvenanceLockGuard(
  provenances: ComponentProvenanceRegistry,
  lockfiles: ComponentLockfileLedger,
): ExtensionProvenanceLockGuard {
  return {
    inspect(manifests) {
      const decisions = new ComponentLockEnforcementService().inspect(extensionObservations(manifests), provenances.list(), lockfiles.latest());
      return new Map(decisions.map((decision) => [decision.componentId, decision.reasons]));
    },
  };
}

/** Gateway 冷路径构件锁定报告：仅归纳已登记 manifest 与 append-only provenance/lock metadata。 */
export function createGatewayComponentLockReport(sources: GatewayComponentLockSources): GatewayComponentLockReportV1 {
  const observations = [
    ...extensionObservations(sources.extensions.list()),
    ...sources.skillPacks.list()
      .filter((pack) => pack.status === 'published')
      .map((pack) => ({ componentId: pack.id, componentKind: 'skill-pack' as const, version: pack.version, contentDigest: pack.source.digest.toLowerCase() })),
    ...sources.agentAdapters.listManifests()
      .filter((adapter) => adapter.status === 'reviewed')
      .map((adapter) => ({ componentId: adapter.id, componentKind: 'agent-adapter' as const, version: adapter.version, contentDigest: adapter.source.digest.toLowerCase() })),
  ];
  const lockfile = sources.lockfiles.latest();
  return {
    schemaVersion: 1,
    inspectedAt: (sources.now ?? Date.now)(),
    lockfile: lockfile ? { revision: lockfile.revision, lockDigest: lockfile.lockDigest } : undefined,
    decisions: new ComponentLockEnforcementService().inspect(observations, sources.provenances.list(), lockfile),
    canActivate: false,
    canAutoRepair: false,
  };
}
