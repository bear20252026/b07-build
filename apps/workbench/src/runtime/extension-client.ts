export type WorkbenchExtensionStatus = 'discovered' | 'reviewed' | 'installed' | 'disabled' | 'revoked';
export type WorkbenchExtensionDecision = 'selected' | 'blocked' | 'ignored';

export interface WorkbenchExtensionManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: string;
  displayName: string;
  source: Readonly<{ type: string; locator: string; digest: string }>;
  declaredCapabilities: readonly string[];
  requestedPermissions: readonly string[];
  dataBoundary: string;
  resourceBudget: Readonly<{ maxMemoryMb: number; maxCpuMs: number; maxStartupMs: number }>;
  entry?: Readonly<{ mode: string; ref: string }>;
  status: WorkbenchExtensionStatus;
  revision: number;
  reviewedBy?: string;
  note?: string;
}

export interface WorkbenchExtensionDiagnostic {
  extensionId: string;
  revision: number;
  severity: 'info' | 'warning';
  code: string;
  message: string;
}

export interface WorkbenchProviderProfile {
  schemaVersion: 1;
  id: string;
  displayName: string;
  driverIds: readonly string[];
  maximumDataBoundary: string;
  credentialReference?: string;
  status: 'registered' | 'active' | 'disabled' | 'revoked';
  revision: number;
  reviewedBy: string;
  note?: string;
}

export interface WorkbenchExtensionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  runId: string;
  outcome: 'ready' | 'blocked';
  entries: readonly Readonly<{
    extensionId: string;
    revision: number;
    kind: string;
    decision: WorkbenchExtensionDecision;
    reasons: readonly Readonly<{ code: string; detail: string }>[];
    effectiveCapabilities: readonly string[];
    canExecute: false;
  }>[];
}

export interface WorkbenchExtensionControlState {
  extensions: readonly WorkbenchExtensionManifest[];
  diagnostics: readonly WorkbenchExtensionDiagnostic[];
  providerProfiles: readonly WorkbenchProviderProfile[];
  plans: readonly WorkbenchExtensionPlan[];
}

function assertArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 返回了非数组 DTO`);
}

function isExtension(value: unknown): value is WorkbenchExtensionManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkbenchExtensionManifest>;
  return candidate.schemaVersion === 1 && typeof candidate.id === 'string' && typeof candidate.displayName === 'string'
    && typeof candidate.status === 'string' && Array.isArray(candidate.declaredCapabilities) && Array.isArray(candidate.requestedPermissions);
}

function isDiagnostic(value: unknown): value is WorkbenchExtensionDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkbenchExtensionDiagnostic>;
  return typeof candidate.extensionId === 'string' && typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

function isProviderProfile(value: unknown): value is WorkbenchProviderProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkbenchProviderProfile>;
  return candidate.schemaVersion === 1 && typeof candidate.id === 'string' && typeof candidate.displayName === 'string'
    && Array.isArray(candidate.driverIds) && typeof candidate.status === 'string';
}

function isPlan(value: unknown): value is WorkbenchExtensionPlan {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkbenchExtensionPlan>;
  return candidate.schemaVersion === 1 && typeof candidate.planId === 'string' && typeof candidate.taskId === 'string'
    && typeof candidate.runId === 'string' && Array.isArray(candidate.entries);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(await response.text() || `扩展控制面请求失败 (${response.status})`);
  return response.json() as Promise<unknown>;
}

/**
 * 浏览器只读扩展控制面。所有状态变更仍必须经过网关的显式审核意图与服务端状态机；
 * 本客户端故意不暴露 discovery、install、enable、secret、入口加载或 execute 方法。
 */
export class HttpWorkbenchExtensionClient {
  constructor(private readonly baseUrl = '/api') {}

  async overview(taskId?: string, runId?: string): Promise<WorkbenchExtensionControlState> {
    const planUrl = taskId && runId
      ? `${this.baseUrl}/extensions/plans/${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`
      : undefined;
    const [extensionsPayload, diagnosticsPayload, profilesPayload, plansPayload] = await Promise.all([
      getJson(`${this.baseUrl}/extensions`),
      getJson(`${this.baseUrl}/extensions/doctor`),
      getJson(`${this.baseUrl}/providers/profiles`),
      planUrl ? getJson(planUrl) : Promise.resolve([]),
    ]);
    assertArray(extensionsPayload, 'extensions');
    assertArray(diagnosticsPayload, 'extension diagnostics');
    assertArray(profilesPayload, 'provider profiles');
    assertArray(plansPayload, 'extension plans');
    if (!extensionsPayload.every(isExtension)) throw new Error('extensions DTO 不兼容');
    if (!diagnosticsPayload.every(isDiagnostic)) throw new Error('extension diagnostics DTO 不兼容');
    if (!profilesPayload.every(isProviderProfile)) throw new Error('provider profiles DTO 不兼容');
    if (!plansPayload.every(isPlan)) throw new Error('extension plans DTO 不兼容');
    return {
      extensions: extensionsPayload,
      diagnostics: diagnosticsPayload,
      providerProfiles: profilesPayload,
      plans: plansPayload,
    };
  }
}
