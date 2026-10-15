// 一个文件=一种作用：子代理 profile 模型、markdown 覆盖加载与归一化。
//
// 移植自 ZCode `apps/zcode-cli/packages/core/src/subagent/profile.ts`，markdown 解析
// 移植自 `packages/shared/src/subagent-profile-parser.ts`（去 zod，手写宽松 frontmatter）。
// 三条语义要点：
//   1. 内置 general-purpose / explore 先入表，用户/项目 profile 按 name 覆盖；
//   2. 「同名覆盖不得继承内置行为」——isBuiltInExploreProfile 的判据是
//      name === 'explore' && source === 'built-in'，不能只按名称套用内置只读工具面；
//   3. 归一化输出按 name 去重（后写入者覆盖先写入者）。

import { basename } from 'node:path';
import { formatExploreAllowedToolsForAgentDescription } from './subagent-explore-tools.js';
import { buildExploreSystemPrompt, buildGeneralPurposeSystemPrompt } from './subagent-prompts.js';
import { filterSubagentChildToolNames } from './subagent-tool-policy.js';

/** 内置通用子代理名。 */
export const GENERAL_PURPOSE_AGENT_TYPE = 'general-purpose';
/** 内置只读探索子代理名（与只读子任务的 explore 角色同名）。 */
export const EXPLORE_AGENT_TYPE = 'explore';

export type SubagentProfileSource = 'built-in' | 'project' | 'user';
export type SubagentProfileColor =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan';
export type SubagentMemoryScope = 'user' | 'project' | 'local';

/** 轻量模型选择：不引入上游 provider 模型解析，只保留可持久化的两段标识。 */
export interface SubagentModelSelection {
  providerId: string;
  modelId: string;
}

export interface SubagentProfile {
  name: string;
  description: string;
  source: SubagentProfileSource;
  systemPrompt: string;
  color?: SubagentProfileColor;
  injectAgentsMd?: boolean;
  /** 工具白名单；`['*']` 表示不限制。 */
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  modelSelection?: SubagentModelSelection;
  maxTurns?: number;
  memory?: SubagentMemoryScope;
  /** markdown 定义来源路径；用于展示 `name (basename)`。 */
  path?: string;
}

export interface SubagentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface SubagentProfileParseResult {
  diagnostic?: SubagentProfileParseDiagnostic;
  profile?: SubagentProfile;
}

/** 内置子代理的模型选择覆盖（不落盘，仅进程内归一化用）。 */
export interface BuiltInSubagentModelSelectionOverrides {
  'general-purpose'?: SubagentModelSelection;
  explore?: SubagentModelSelection;
}

const VALID_COLORS = new Set<string>([
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
]);
const VALID_MEMORY_SCOPES = new Set<string>(['user', 'project', 'local']);

/** 内置 general-purpose：工具面不限制，注入 AGENTS.md。 */
export function createBuiltInGeneralPurposeProfile(
  options: { modelSelection?: SubagentModelSelection } = {},
): SubagentProfile {
  return {
    name: GENERAL_PURPOSE_AGENT_TYPE,
    description:
      '通用子代理：研究复杂问题、检索代码并执行多步任务。当你在前几次尝试内没有把握找到关键字或文件时，交给它代你检索。',
    // 内置子代理使用显式身份色，避免 UI 按名称 hash 后把 general-purpose 显示成红色。
    color: 'blue',
    injectAgentsMd: true,
    source: 'built-in',
    systemPrompt: buildGeneralPurposeSystemPrompt(),
    tools: ['*'],
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
  };
}

/** 内置 explore：只读工具面（见 subagent-explore-tools），不注入 AGENTS.md。 */
export function createBuiltInExploreProfile(
  options: { modelSelection?: SubagentModelSelection; embeddedSearchEnabled?: boolean } = {},
): SubagentProfile {
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      '只读检索子代理：需要横扫大量文件、目录或命名约定、且只要结论不要文件全文时使用。它读取片段而非整文件，因此只定位代码，不做审查或审计。',
    color: 'cyan',
    injectAgentsMd: false,
    source: 'built-in',
    // b07 差异：上游在 runner 运行时构造 explore 提示词（profile.systemPrompt 为空），
    // 因未移植 runner，这里直接固化进 profile，让只读契约随 profile 一起可见。
    systemPrompt: buildExploreSystemPrompt({ embeddedSearchEnabled: options.embeddedSearchEnabled }),
    tools: ['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'TodoWrite'],
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
  };
}

/**
 * 是否为「内置」explore：用户/项目 profile 可以同名覆盖内置 explore，
 * 不能只按名称套用内置只读行为。
 */
export function isBuiltInExploreProfile(profile: Pick<SubagentProfile, 'name' | 'source'>): boolean {
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === 'built-in';
}

/** 内置先入表，再按 name 用传入 profile 覆盖；返回去重后的活动 profile 列表。 */
export function normalizeAgentProfiles(
  profiles: readonly SubagentProfile[],
  options: { builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides } = {},
): SubagentProfile[] {
  const overrides = options.builtInModelSelectionOverrides ?? {};
  const active = new Map<string, SubagentProfile>();
  active.set(
    GENERAL_PURPOSE_AGENT_TYPE,
    createBuiltInGeneralPurposeProfile({ modelSelection: overrides[GENERAL_PURPOSE_AGENT_TYPE] }),
  );
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreProfile({ modelSelection: overrides[EXPLORE_AGENT_TYPE] }),
  );
  for (const profile of profiles) active.set(profile.name, profile);
  return Array.from(active.values());
}

/** profile 展示名：带 path 时显示 `name (basename)`。 */
export function agentProfileDisplayName(profile: SubagentProfile): string {
  return profile.path ? `${profile.name} (${basename(profile.path)})` : profile.name;
}

/** 生成单条 profile 的提示词行；内置 explore 用优先级排序后的工具清单。 */
export function formatAgentProfileForPrompt(
  profile: Readonly<SubagentProfile>,
  options: { embeddedSearchEnabled?: boolean } = {},
): string {
  const tools = isBuiltInExploreProfile(profile)
    ? formatExploreAllowedToolsForAgentDescription(options)
    : profile.tools
      ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
      : undefined;
  const toolText = typeof tools === 'string' ? tools : tools?.join(', ');
  return `- ${profile.name}: ${profile.description}${toolText ? ` (Tools: ${toolText})` : ''}`;
}

/** 生成完整的可用子代理清单；始终含两个内置，因此不会返回 null（保留上游签名语义）。 */
export function formatAgentProfilesForPrompt(
  profiles: readonly SubagentProfile[],
  options: { embeddedSearchEnabled?: boolean } = {},
): string | null {
  const active = normalizeAgentProfiles(profiles);
  if (active.length === 0) return null;
  return [
    'Available agent types and the tools they have access to:',
    ...active.map((profile) => formatAgentProfileForPrompt(profile, options)),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// markdown frontmatter 解析（宽松 YAML 子集，无第三方依赖）
// ---------------------------------------------------------------------------

function splitMarkdownFrontmatter(content: string): { body: string; frontmatter?: string } {
  const normalized = content.replace(/^\uFEFF/u, '');
  const lines = normalized.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return { body: normalized };
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex < 0) return { body: normalized };
  return {
    frontmatter: lines.slice(1, endIndex).join('\n'),
    body: lines.slice(endIndex + 1).join('\n'),
  };
}

function stripInlineComment(value: string): string {
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? undefined : (quote ?? char);
    }
    if (!quote && char === '#' && /\s/u.test(value[index - 1] ?? '')) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function unquoteScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function splitTopLevelList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const char of value) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      current += char;
      continue;
    }
    if (!quote && char === ',') {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseScalar(raw: string): unknown {
  const value = stripInlineComment(raw.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/u.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitTopLevelList(value.slice(1, -1)).map((item) => unquoteScalar(item.trim()));
  }
  return unquoteScalar(value);
}

/** 宽松 frontmatter：`key: value`、`key:` + 缩进 `- item` 列表、`[a, b]` 内联列表。 */
function parseFrontmatterValues(frontmatter: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let pendingListKey: string | undefined;
  for (const rawLine of frontmatter.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const listMatch = line.match(/^\s*-\s+(.*)$/u);
    if (listMatch && pendingListKey) {
      const existing = Array.isArray(values[pendingListKey]) ? (values[pendingListKey] as unknown[]) : [];
      values[pendingListKey] = [...existing, parseScalar(listMatch[1] ?? '')];
      continue;
    }

    pendingListKey = undefined;
    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!keyValue) continue;
    const key = keyValue[1];
    const rawValue = keyValue[2] ?? '';
    if (rawValue.trim() === '') {
      values[key] = [];
      pendingListKey = key;
      continue;
    }
    values[key] = parseScalar(rawValue);
  }
  return values;
}

function scalarString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeColor(value: string | undefined): SubagentProfileColor | undefined {
  return value && VALID_COLORS.has(value) ? (value as SubagentProfileColor) : undefined;
}

function normalizeMemoryScope(value: string | undefined): SubagentMemoryScope | undefined {
  return value && VALID_MEMORY_SCOPES.has(value) ? (value as SubagentMemoryScope) : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * 工具规格 `Tool(pattern)` 取括号前的工具名；数组或逗号/空白分隔字符串都接受。
 * 显式空列表（`tools: []`）返回 `[]` 而非 undefined——空白名单必须表示「无工具」，
 * 不能被折叠成「未指定」而反向放大权限。
 */
function parseToolList(value: unknown): string[] | undefined {
  let raw: readonly string[];
  if (Array.isArray(value)) {
    raw = value.filter((item): item is string => typeof item === 'string');
  } else if (typeof value === 'string') {
    raw = value.split(/[,\s]+/u).map((item) => item.trim()).filter(Boolean);
  } else {
    return undefined;
  }
  return raw
    .map((item) => {
      const parenIndex = item.indexOf('(');
      return parenIndex < 0 ? item.trim() : item.slice(0, parenIndex).trim();
    })
    .filter((item) => item.length > 0);
}

function missingRequiredDiagnostic(
  field: string,
  path: string | undefined,
): SubagentProfileParseResult {
  return {
    diagnostic: {
      code: 'agent_missing_required_frontmatter',
      message: `Agent frontmatter 必须包含 ${field}：${path ?? '<inline>'}`,
      path,
    },
  };
}

/**
 * 从 markdown 解析 profile：`---` frontmatter 提供 name/description/tools 等，
 * 正文即 systemPrompt。缺 frontmatter 或必填字段返回 diagnostic，不抛错。
 */
export function parseAgentProfileFromMarkdown(input: {
  content: string;
  path?: string;
  source: SubagentProfileSource;
}): SubagentProfileParseResult {
  const parsed = splitMarkdownFrontmatter(input.content);
  if (!parsed.frontmatter) {
    return {
      diagnostic: {
        code: 'agent_missing_frontmatter',
        message: `Agent markdown 必须包含 frontmatter：${input.path ?? '<inline>'}`,
        path: input.path,
      },
    };
  }

  const frontmatter = parseFrontmatterValues(parsed.frontmatter);
  const name = scalarString(frontmatter.name);
  const description = scalarString(frontmatter.description)?.replace(/\\n/gu, '\n');
  if (!name) return missingRequiredDiagnostic('name', input.path);
  if (!description) return missingRequiredDiagnostic('description', input.path);

  const tools = parseToolList(frontmatter.tools);
  const disallowedTools = parseToolList(frontmatter.disallowedTools);
  const color = normalizeColor(scalarString(frontmatter.color));
  const memory = normalizeMemoryScope(scalarString(frontmatter.memory));
  const maxTurns = normalizePositiveInteger(frontmatter.maxTurns);

  return {
    profile: {
      name,
      description,
      source: input.source,
      systemPrompt: parsed.body.trim(),
      ...(input.path ? { path: input.path } : {}),
      ...(color ? { color } : {}),
      ...(memory ? { memory } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(typeof frontmatter.injectAgentsMd === 'boolean'
        ? { injectAgentsMd: frontmatter.injectAgentsMd }
        : {}),
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
    },
  };
}
