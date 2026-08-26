export interface WorkbenchAgencyRoleSource {
  readonly repository: 'msitarzewski/agency-agents';
  readonly upstreamPath: string;
  readonly upstreamUrl: string;
  readonly license: 'MIT';
  readonly copyright: 'Copyright (c) 2025 AgentLand Contributors';
  readonly contentDigest: string;
}

export interface WorkbenchAgencyRoleSummary {
  readonly id: string;
  readonly division: 'engineering' | 'design' | 'product' | 'testing';
  readonly displayName: string;
  readonly description: string;
  readonly source: WorkbenchAgencyRoleSource;
  readonly canAutoInject: false;
  readonly canAuthorize: false;
  readonly canGrantCapabilities: false;
}

export interface WorkbenchAgencyRoleDetail extends WorkbenchAgencyRoleSummary { readonly content: string; }

export interface WorkbenchAgencyCandidateResult {
  readonly alreadyExists: boolean;
  readonly pack: { readonly id: string; readonly status: 'candidate' | 'reviewed' | 'published' | 'disabled' | 'revoked'; readonly displayName: string; readonly source: { readonly digest: string }; };
}

function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 响应格式无效`); return value as Record<string, unknown>; }
function source(value: unknown): WorkbenchAgencyRoleSource {
  const item = object(value, '角色来源');
  if (item.repository !== 'msitarzewski/agency-agents' || typeof item.upstreamPath !== 'string' || typeof item.upstreamUrl !== 'string' || item.license !== 'MIT' || item.copyright !== 'Copyright (c) 2025 AgentLand Contributors' || typeof item.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.contentDigest)) throw new Error('角色来源字段无效');
  return { repository: 'msitarzewski/agency-agents', upstreamPath: item.upstreamPath, upstreamUrl: item.upstreamUrl, license: 'MIT', copyright: 'Copyright (c) 2025 AgentLand Contributors', contentDigest: item.contentDigest };
}
function role(value: unknown, includeContent: boolean): WorkbenchAgencyRoleDetail | WorkbenchAgencyRoleSummary {
  const item = object(value, '预置角色');
  if (typeof item.id !== 'string' || !['engineering', 'design', 'product', 'testing'].includes(String(item.division)) || typeof item.displayName !== 'string' || typeof item.description !== 'string' || item.canAutoInject !== false || item.canAuthorize !== false || item.canGrantCapabilities !== false) throw new Error('预置角色字段无效');
  const base = { id: item.id, division: item.division as WorkbenchAgencyRoleSummary['division'], displayName: item.displayName, description: item.description, source: source(item.source), canAutoInject: false as const, canAuthorize: false as const, canGrantCapabilities: false as const };
  if (!includeContent) return base;
  if (typeof item.content !== 'string' || !item.content.includes('Copyright (c) 2025 AgentLand Contributors')) throw new Error('预置角色正文或版权声明无效');
  return { ...base, content: item.content };
}
async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init); const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = object(body, '角色服务'); throw new Error(typeof error.error === 'string' ? error.error : '角色请求未完成'); }
  return body;
}

/** 只读角色浏览与显式候选创建；没有角色安装、自动注入、外部目录写入或角色执行操作。 */
export class HttpAgencyRoleClient {
  constructor(private readonly baseUrl = '') {}
  async list(): Promise<readonly WorkbenchAgencyRoleSummary[]> {
    const body = await request(`${this.baseUrl}/api/agency-roles`); if (!Array.isArray(body)) throw new Error('预置角色列表格式无效');
    return body.map((item) => role(item, false) as WorkbenchAgencyRoleSummary);
  }
  async detail(id: string): Promise<WorkbenchAgencyRoleDetail> { return role(await request(`${this.baseUrl}/api/agency-roles/${encodeURIComponent(id)}`), true) as WorkbenchAgencyRoleDetail; }
  async createCandidate(id: string): Promise<WorkbenchAgencyCandidateResult> {
    const body = object(await request(`${this.baseUrl}/api/agency-roles/${encodeURIComponent(id)}/candidate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'agency-role-candidate-v1' }, body: '{}' }), '角色候选');
    const pack = object(body.pack, '角色候选 pack');
    if (typeof body.alreadyExists !== 'boolean' || typeof pack.id !== 'string' || !['candidate', 'reviewed', 'published', 'disabled', 'revoked'].includes(String(pack.status)) || typeof pack.displayName !== 'string' || !pack.source || typeof object(pack.source, '角色候选来源').digest !== 'string') throw new Error('角色候选响应无效');
    return { alreadyExists: body.alreadyExists, pack: { id: pack.id, status: pack.status as WorkbenchAgencyCandidateResult['pack']['status'], displayName: pack.displayName, source: { digest: String(object(pack.source, '角色候选来源').digest) } } };
  }
}
