// 一个文件=一种作用：权限决策链与规则匹配（evaluatePermission）。
//
// 借鉴 ZCode `core/src/permission/service.ts` 的固定优先级决策链，落到 b07
// 已有的 Capability 模型上。与既有三层策略（RuleBased / Authority / Profiled）
// 的关系：本链是**规则层 + 模式兜底**的纯函数实现，Authority overlay 仍是
// 其上的一层收紧器（它只能把 require_approval 收窄为 allow，或整体 deny），
// 两者组合而不是取代。
//
// 优先级（与 ZCode 同构，deny 永远先于 allow）：
//   1. 模式规则（toolPattern + patternInput 同时声明）：deny → allow → ask；
//   2. 精确规则（capability + risk 完全匹配）：deny → allow → ask；
//   3. 能力级规则（capability 匹配、risk 未指定）：deny → allow → ask；
//   4. 模式兜底（无任何规则命中时按权威姿态给缺省决策）；
//   5. 仍无结论：fail-closed 拒绝——新增能力漏配规则绝不等于放行。
//
// 单向收窄原则（ZCode approval-gate 同款）：任何后续层只能把 ask 降为 allow，
// 不能把 allow 升为 ask；本链的输出因此可被 Authority/Profile 安全包装。

import type {
  CapabilityEvaluation,
  CapabilityPolicyRule,
  CapabilityRequest,
  ExecutionAuthorityMode,
} from '@awo/protocol';

/** 通配匹配：`*` 不跨 `/` 分隔符（但含点号，文件扩展名可匹配），`**` 跨分隔符；空模式 = 匹配一切。 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('**')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

export function matchesPattern(value: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern.length === 0) return true;
  return globToRegExp(pattern).test(value);
}

/** 域名匹配：`example.com` 精确、`*.example.com` 一级通配（与 ZCode domain 主体匹配对齐）。 */
export function matchesDomain(value: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern.length === 0) return true;
  if (!pattern.startsWith('*.')) return value === pattern;
  const suffix = pattern.slice(1);
  return value.endsWith(suffix) && value.length > suffix.length && !value.slice(0, -suffix.length).includes('.');
}

/** 模式规则 = 同时声明了 toolPattern 与 patternInput 的规则（按作用对象收窄的 allowlist）。 */
export function isScopedRule(rule: CapabilityPolicyRule): boolean {
  return rule.toolPattern !== undefined && rule.patternInput !== undefined;
}

export function ruleMatches(rule: CapabilityPolicyRule, request: CapabilityRequest): boolean {
  if (rule.capability !== request.capability) return false;
  if (rule.risk !== undefined && rule.risk !== request.risk) return false;
  if (rule.toolPattern !== undefined) {
    if (request.toolName === undefined) return false;
    if (!matchesPattern(request.toolName, rule.toolPattern)) return false;
  }
  if (rule.patternInput !== undefined) {
    if (request.patternInput === undefined) return false;
    if (rule.patternInputKind === 'domain') {
      if (!matchesDomain(request.patternInput, rule.patternInput)) return false;
    } else if (!matchesPattern(request.patternInput, rule.patternInput)) {
      return false;
    }
  }
  return true;
}

export interface PermissionChainRequest extends CapabilityRequest {}

export interface PermissionChainOptions {
  readonly rules: readonly CapabilityPolicyRule[];
  readonly authorityMode: ExecutionAuthorityMode;
  /** plan 姿态下仍然只读放行的能力（缺省取执行授权模块同款最小集）。 */
  readonly readOnlyCapabilities?: readonly CapabilityRequest['capability'][];
}

export interface PermissionEvaluation extends CapabilityEvaluation {}

/**
 * 在给定规则集内决策：deny → allow → require_approval 逐级寻找首个命中，
 * 命中即返回（含 ruleId）。未命中返回 undefined，由调用方走下一特异度。
 */
export function decideFromRules(
  rules: readonly CapabilityPolicyRule[],
  request: CapabilityRequest,
): CapabilityEvaluation | undefined {
  // 同一特异度内 deny 先行：显式拒绝永远压过显式允许（ZCode project deny 先于 ask）。
  for (const decision of ['deny', 'allow', 'require_approval'] as const) {
    const hit = rules.find((rule) => rule.decision === decision && ruleMatches(rule, request));
    if (hit) {
      return {
        decision: hit.decision,
        reason: hit.reason,
        ...(hit.ruleId === undefined ? {} : { ruleId: hit.ruleId }),
      };
    }
  }
  return undefined;
}

const PLAN_READ_ONLY = new Set<CapabilityRequest['capability']>(['filesystem.read', 'document.parse']);

/**
 * 决策链入口：规则层（模式 → 精确 → 能力级）→ 姿态兜底 → fail-closed。
 * 纯函数：不读时钟、不碰存储，可被任何执行路径（DAG runner、MCP 网关、CLI）复用。
 */
export function evaluatePermission(
  request: PermissionChainRequest,
  options: PermissionChainOptions,
): PermissionEvaluation {
  const scoped = options.rules.filter(isScopedRule);
  const exact = options.rules.filter((rule) => !isScopedRule(rule) && rule.risk !== undefined);
  const wide = options.rules.filter((rule) => !isScopedRule(rule) && rule.risk === undefined);

  const fromRules =
    decideFromRules(scoped, request) ?? decideFromRules(exact, request) ?? decideFromRules(wide, request);
  if (fromRules) return fromRules;

  const readOnly = options.readOnlyCapabilities ?? [...PLAN_READ_ONLY];
  switch (options.authorityMode) {
    case 'plan':
      return readOnly.includes(request.capability)
        ? { decision: 'allow', reason: `Plan 姿态放行只读能力 ${request.capability}` }
        : { decision: 'deny', reason: `Plan 姿态禁止 ${request.capability}（非只读）；请改用 review/automate 或管理员租约` };
    case 'review':
      return request.risk === 'high'
        ? { decision: 'require_approval', reason: `Review 姿态下 high 风险 ${request.capability} 需人工批准` }
        : { decision: 'allow', reason: `Review 姿态放行 ${request.capability}` };
    case 'automate':
      return request.risk === 'high'
        ? { decision: 'require_approval', reason: `Automate 姿态保留 high 风险 ${request.capability} 的人工批准` }
        : { decision: 'allow', reason: `Automate 姿态在声明能力内放行 ${request.capability}` };
    case 'admin':
      return { decision: 'allow', reason: `Admin 姿态放行 ${request.capability}（进入审计轨迹）` };
    default:
      return { decision: 'deny', reason: `未知权威姿态，失败关闭：${String(options.authorityMode)}` };
  }
}

/**
 * 把决策链包装成 CapabilityPolicy（即插即用）：ControlledToolRunner 等
 * 既有消费者零改动即可获得规则匹配 + 可解释 ruleId + 姿态兜底。
 */
export function permissionChainPolicy(options: PermissionChainOptions): { evaluate(request: CapabilityRequest): CapabilityEvaluation } {
  return { evaluate: (request) => evaluatePermission(request, options) };
}
