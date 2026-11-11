// 预置角色目录（应用侧只读）。
//
// ## 数据从哪来
//
// `apps/workbench/src/generated/agency-role-catalog.json`，由
// `npm run agency:catalog` 从 `@awo/knowledge-workflow` 的 `AgencyRoleCatalog` 导出。
// 那份数据的派生逻辑只有一份（在那个包里），这里只负责**读和校验**。
//
// ## 为什么要校验
//
// 生成文件是构建产物，理论上可信；但它同时是**跨边界**的数据（从 Node 侧包导出到
// 渲染进程）。一旦生成脚本改动或产物被手改，未校验的数据会直接进界面。
// 校验失败时**丢弃该条并如实报数**，而不是让界面显示 `undefined`。
//
// ## 角色正文的定位
//
// 它是**静态、不可信的上下文候选**：可以给模型看，但不授予任何能力。
// `canAutoInject` / `canAuthorize` / `canGrantCapabilities` 三个字段恒为 `false`，
// 这里连校验都要求它们是 `false` —— 如果哪天生成出 `true`，说明上游语义变了，
// 那时应该显式改这个模块，而不是让一个 `true` 悄悄流进界面。

import catalogJson from '../generated/agency-role-catalog.json';

/** 角色分部。 */
export type AgencyDivision = 'engineering' | 'design' | 'product' | 'testing';

const DIVISIONS = new Set<string>(['engineering', 'design', 'product', 'testing']);

/** 一条预置角色。 */
export interface AgencyRole {
  readonly id: string;
  readonly division: AgencyDivision;
  readonly displayName: string;
  readonly description: string;
  /** 角色正文（静态上下文候选）。 */
  readonly content: string;
  /** 来源信息，用于界面上的版权归因。 */
  readonly upstreamUrl: string;
  readonly license: string;
  readonly copyright: string;
}

/** 一条校验并归一化；形状或语义不对就返回 `undefined`。 */
export function toAgencyRole(value: unknown): AgencyRole | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as {
    id?: unknown;
    division?: unknown;
    displayName?: unknown;
    description?: unknown;
    content?: unknown;
    source?: { upstreamUrl?: unknown; license?: unknown; copyright?: unknown };
    canAutoInject?: unknown;
    canAuthorize?: unknown;
    canGrantCapabilities?: unknown;
  };
  if (typeof input.id !== 'string' || !input.id.trim()) return undefined;
  if (typeof input.division !== 'string' || !DIVISIONS.has(input.division)) return undefined;
  if (typeof input.displayName !== 'string' || !input.displayName.trim()) return undefined;
  if (typeof input.description !== 'string') return undefined;
  if (typeof input.content !== 'string' || !input.content.trim()) return undefined;
  // 三个能力字段必须**明确为 false**：缺失也拒（缺失说明生成侧没写，语义不明）。
  if (input.canAutoInject !== false || input.canAuthorize !== false || input.canGrantCapabilities !== false) return undefined;
  const source = input.source;
  if (!source || typeof source.upstreamUrl !== 'string' || typeof source.license !== 'string' || typeof source.copyright !== 'string') return undefined;
  return {
    id: input.id,
    division: input.division as AgencyDivision,
    displayName: input.displayName,
    description: input.description,
    content: input.content,
    upstreamUrl: source.upstreamUrl,
    license: source.license,
    copyright: source.copyright,
  };
}

/** 目录读取结果。 */
export interface AgencyRoleCatalogSnapshot {
  readonly roles: readonly AgencyRole[];
  /** 因形状/语义不合法被丢弃的条目数。>0 时界面应提示"目录不完整"。 */
  readonly dropped: number;
  /** 生成产物声明的来源许可（用于归因）。 */
  readonly license: string;
  readonly copyright: string;
}

/** 读取内置目录。同步：数据已随包打进产物，没有网络也没有 IO。 */
export function loadAgencyRoles(): AgencyRoleCatalogSnapshot {
  const raw = catalogJson as { roles?: unknown; license?: unknown; copyright?: unknown };
  const entries = Array.isArray(raw.roles) ? raw.roles : [];
  const roles: AgencyRole[] = [];
  for (const entry of entries) {
    const role = toAgencyRole(entry);
    if (role) roles.push(role);
  }
  return {
    roles,
    dropped: entries.length - roles.length,
    license: typeof raw.license === 'string' ? raw.license : '未知',
    copyright: typeof raw.copyright === 'string' ? raw.copyright : '未知',
  };
}

/** 分部的中文标签。 */
export const AGENCY_DIVISION_LABEL: Readonly<Record<AgencyDivision, string>> = {
  engineering: '工程',
  design: '设计',
  product: '产品',
  testing: '测试',
};
