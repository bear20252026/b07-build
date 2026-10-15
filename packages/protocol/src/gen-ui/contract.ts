// 一个文件=一种作用：Gen UI 契约层——Agent 即时生成 HTML 页面的引用/作用域/Widget 状态/
// Tweak 控件/模型上下文的纯逻辑边界（无 DOM、无 IO，可独立单测）。
//
// 移植自 ZCode `packages/shared/src/gen-ui/contract.ts`（Apache-2.0，见 THIRD-PARTY-NOTICES.md）。
// b07 差异：上游用 zod 表达 schema，本包未依赖 zod（仅 ajv），故改为手写校验，返回
// `{ ok, reason }` 结果而不是抛异常的 parse——与本包 `mcp-app-admission.ts` 同一纪律
// （fail-closed，稳定 reason 码）。所有上限、正则、键构造与注入隔离语义与上游逐字对齐。
//
// 关键安全语义（不可省略）：
// - 模型上下文包在 `<untrusted_gen_ui_state>…</untrusted_gen_ui_state>` 内，并把 `<`
//   转义为 `\u003c`，使 Widget 状态无法伪造闭合标签越狱提示词；`stripGenUiModelContext`
//   只在块可被完整解析为合法状态数组时才剥离。

export const GEN_UI_HTML_MAX_BYTES = 5_000_000;
export const GEN_UI_STATE_MAX_BYTES = 16 * 1024;
export const GEN_UI_STATE_MAX_ENTRIES = 100;
export const GEN_UI_CONTEXT_MAX_BYTES = 64 * 1024;
export const GEN_UI_GLOBALS_EVENT = 'zcode:set_globals';
export const GEN_UI_STATE_CONTEXT_KEY = 'zcode/genUiState';
export const GEN_UI_TWEAK_CONTEXT_KEY = 'zcode/genUiTweaks';
export const GEN_UI_STATE_METHOD = 'zcode/gen-ui/state';
export const GEN_UI_FOLLOW_UP_METHOD = 'zcode/gen-ui/follow-up';
export const GEN_UI_TWEAK_METHOD = 'zcode/gen-ui/tweak';
export const GEN_UI_PRESENTATION_METHOD = 'zcode/gen-ui/presentation';

/** CDN 静态域白名单：Gen UI 页面允许从这些来源加载脚本/样式/字体，其余一律拒绝。 */
export const GEN_UI_STATIC_DOMAINS = [
  'cdnjs.cloudflare.com',
  'esm.sh',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'fonts.bunny.net',
] as const;

/** 校验结果：成功带规范化后的值，失败带稳定 reason 码（调用方据此记录/应答）。 */
export type GenUiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const textEncoder = new TextEncoder();

/** UTF-8 字节长度：所有上限按字节而非字符计（与上游一致）。 */
export function genUiByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function isGenUiPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 封闭键校验：只允许声明过的键（协议包统一纪律，未声明字段一律拒绝）。 */
export function rejectGenUiUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isGenUiNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

const GEN_UI_PATH_MAX_CHARS = 4096;
const GEN_UI_PATH_ABSOLUTE_PREFIX = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;
const GEN_UI_PATH_LAST_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/u;

/**
 * 路径校验（wire-format 检查）：绝对路径、无 `..` 段、无 `\0`/CRLF，
 * 且末段必须是小写连字符的 `*.html`。执行器负责归一化与文件系统授权。
 */
export function isGenUiPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > GEN_UI_PATH_MAX_CHARS) return false;
  if (value.includes('\0') || /[\r\n]/u.test(value)) return false;
  const segments = value.split(/[\\/]/u);
  return (
    GEN_UI_PATH_ABSOLUTE_PREFIX.test(value) &&
    !segments.includes('..') &&
    GEN_UI_PATH_LAST_SEGMENT.test(segments[segments.length - 1] ?? '')
  );
}

export interface GenUiReference {
  readonly path: string;
  readonly title?: string;
  readonly mode?: 'wide';
}

export function parseGenUiReference(value: unknown): GenUiResult<GenUiReference> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-reference-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['path', 'title', 'mode'])) return { ok: false, reason: 'gen-ui-reference-unknown-key' };
  if (!isGenUiPath(value.path)) return { ok: false, reason: 'gen-ui-path-invalid' };
  if (value.title !== undefined && !(typeof value.title === 'string' && value.title.length <= 250)) {
    return { ok: false, reason: 'gen-ui-reference-title-invalid' };
  }
  if (value.mode !== undefined && value.mode !== 'wide') return { ok: false, reason: 'gen-ui-reference-mode-invalid' };
  return {
    ok: true,
    value: {
      path: value.path,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(value.mode === undefined ? {} : { mode: value.mode }),
    },
  };
}

export interface GenUiScope {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly sessionId: string;
}

export interface GenUiStateTarget extends GenUiScope {
  readonly path: string;
}

export function parseGenUiScope(value: unknown): GenUiResult<GenUiScope> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-scope-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['workspacePath', 'workspaceIdentity', 'sessionId'])) {
    return { ok: false, reason: 'gen-ui-scope-unknown-key' };
  }
  if (!isGenUiNonEmptyString(value.workspacePath, 4096)) return { ok: false, reason: 'gen-ui-workspace-path-invalid' };
  if (value.workspaceIdentity !== undefined && !(typeof value.workspaceIdentity === 'string' && value.workspaceIdentity.length <= 4096)) {
    return { ok: false, reason: 'gen-ui-workspace-identity-invalid' };
  }
  if (!isGenUiNonEmptyString(value.sessionId, 512)) return { ok: false, reason: 'gen-ui-session-id-invalid' };
  return {
    ok: true,
    value: {
      workspacePath: value.workspacePath,
      ...(value.workspaceIdentity === undefined ? {} : { workspaceIdentity: value.workspaceIdentity }),
      sessionId: value.sessionId,
    },
  };
}

export function parseGenUiStateTarget(value: unknown): GenUiResult<GenUiStateTarget> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-scope-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['workspacePath', 'workspaceIdentity', 'sessionId', 'path'])) {
    return { ok: false, reason: 'gen-ui-scope-unknown-key' };
  }
  // 作用域 schema 只认作用域键；状态目标额外带 path，故先投影出作用域部分再校验。
  const scope = parseGenUiScope({
    workspacePath: value.workspacePath,
    ...(value.workspaceIdentity === undefined ? {} : { workspaceIdentity: value.workspaceIdentity }),
    sessionId: value.sessionId,
  });
  if (!scope.ok) return scope;
  if (!isGenUiPath(value.path)) return { ok: false, reason: 'gen-ui-path-invalid' };
  return { ok: true, value: { ...scope.value, path: value.path } };
}

export interface GenUiWidgetState {
  readonly modelContent: unknown;
  readonly privateContent: unknown;
}

/**
 * Widget 状态：只允许 JSON 值（undefined/function/symbol/bigint/非有限数一律拒绝），
 * 序列化后 ≤16KiB。`modelContent` 会进模型上下文，`privateContent` 绝不进。
 */
function serializeGenUiJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (
        typeof item === 'undefined' ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'bigint' ||
        (typeof item === 'number' && !Number.isFinite(item))
      ) {
        throw new Error('Widget state must contain JSON values only');
      }
      return item;
    });
  } catch {
    // 循环引用或非法值：JSON.stringify 抛错，统一按不可序列化处理。
    return undefined;
  }
}

export function parseGenUiWidgetState(value: unknown): GenUiResult<GenUiWidgetState> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-state-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['modelContent', 'privateContent'])) {
    return { ok: false, reason: 'gen-ui-state-unknown-key' };
  }
  const normalized = {
    modelContent: value.modelContent ?? null,
    privateContent: value.privateContent ?? null,
  };
  const serialized = serializeGenUiJson(normalized);
  if (serialized === undefined) return { ok: false, reason: 'gen-ui-state-not-json' };
  if (genUiByteLength(serialized) > GEN_UI_STATE_MAX_BYTES) return { ok: false, reason: 'gen-ui-state-too-large' };
  return { ok: true, value: JSON.parse(serialized) as GenUiWidgetState };
}

export interface GenUiFollowUp {
  readonly prompt: string;
  readonly title?: string;
}

export function parseGenUiFollowUp(value: unknown): GenUiResult<GenUiFollowUp> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-follow-up-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['prompt', 'title'])) return { ok: false, reason: 'gen-ui-follow-up-unknown-key' };
  if (typeof value.prompt !== 'string') return { ok: false, reason: 'gen-ui-follow-up-prompt-invalid' };
  const prompt = value.prompt.trim();
  if (prompt.length === 0 || prompt.length > 64 * 1024) return { ok: false, reason: 'gen-ui-follow-up-prompt-invalid' };
  if (value.title !== undefined && !(typeof value.title === 'string' && value.title.length <= 250)) {
    return { ok: false, reason: 'gen-ui-follow-up-title-invalid' };
  }
  return { ok: true, value: { prompt, ...(value.title === undefined ? {} : { title: value.title }) } };
}

export type GenUiTweakValue = string | number | boolean;

interface GenUiTweakControlBase {
  readonly id: string;
  readonly label: string;
  readonly reference?: string;
}

export interface GenUiSliderControl extends GenUiTweakControlBase {
  readonly type: 'slider';
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
}

export interface GenUiColorControl extends GenUiTweakControlBase {
  readonly type: 'color';
  readonly value: string;
}

export interface GenUiToggleControl extends GenUiTweakControlBase {
  readonly type: 'toggle';
  readonly value: boolean;
}

export interface GenUiSelectOption {
  readonly label: string;
  readonly value: string;
}

export interface GenUiSelectControl extends GenUiTweakControlBase {
  readonly type: 'select';
  readonly value: string;
  readonly options: readonly (string | GenUiSelectOption)[];
}

export type GenUiTweakControl = GenUiSliderControl | GenUiColorControl | GenUiToggleControl | GenUiSelectControl;

export interface GenUiTweak {
  readonly title: string;
  readonly controls: readonly GenUiTweakControl[];
}

/** 整组 Tweak 的控件数量上限（上游同值）。 */
export const GEN_UI_TWEAK_MAX_CONTROLS = 12;

const GEN_UI_TWEAK_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const GEN_UI_TWEAK_REFERENCE = /^[\w./:@$#-]{1,160}$/u;
const GEN_UI_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseTweakControlBase(value: Record<string, unknown>): GenUiResult<GenUiTweakControlBase> {
  if (typeof value.id !== 'string' || !GEN_UI_TWEAK_ID.test(value.id)) return { ok: false, reason: 'gen-ui-tweak-id-invalid' };
  if (!isGenUiNonEmptyString(value.label, 120)) return { ok: false, reason: 'gen-ui-tweak-label-invalid' };
  if (value.reference !== undefined && !(typeof value.reference === 'string' && GEN_UI_TWEAK_REFERENCE.test(value.reference))) {
    return { ok: false, reason: 'gen-ui-tweak-reference-invalid' };
  }
  return {
    ok: true,
    value: {
      id: value.id,
      label: value.label,
      ...(value.reference === undefined ? {} : { reference: value.reference }),
    },
  };
}

function parseTweakControl(value: unknown): GenUiResult<GenUiTweakControl> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-tweak-control-not-object' };
  const base = parseTweakControlBase(value);
  if (!base.ok) return base;
  switch (value.type) {
    case 'slider': {
      if (!rejectGenUiUnknownKeys(value, ['id', 'label', 'reference', 'type', 'value', 'min', 'max', 'step', 'unit'])) {
        return { ok: false, reason: 'gen-ui-tweak-unknown-key' };
      }
      if (!isFiniteNumber(value.value) || !isFiniteNumber(value.min) || !isFiniteNumber(value.max)) {
        return { ok: false, reason: 'gen-ui-tweak-slider-range-invalid' };
      }
      if (value.step !== undefined && !(isFiniteNumber(value.step) && value.step > 0)) {
        return { ok: false, reason: 'gen-ui-tweak-slider-step-invalid' };
      }
      if (value.unit !== undefined && !(typeof value.unit === 'string' && value.unit.length <= 24)) {
        return { ok: false, reason: 'gen-ui-tweak-slider-unit-invalid' };
      }
      return {
        ok: true,
        value: {
          ...base.value,
          type: 'slider',
          value: value.value,
          min: value.min,
          max: value.max,
          ...(value.step === undefined ? {} : { step: value.step }),
          ...(value.unit === undefined ? {} : { unit: value.unit }),
        },
      };
    }
    case 'color': {
      if (!rejectGenUiUnknownKeys(value, ['id', 'label', 'reference', 'type', 'value'])) {
        return { ok: false, reason: 'gen-ui-tweak-unknown-key' };
      }
      if (typeof value.value !== 'string' || !GEN_UI_COLOR.test(value.value)) return { ok: false, reason: 'gen-ui-tweak-color-invalid' };
      return { ok: true, value: { ...base.value, type: 'color', value: value.value } };
    }
    case 'toggle': {
      if (!rejectGenUiUnknownKeys(value, ['id', 'label', 'reference', 'type', 'value'])) {
        return { ok: false, reason: 'gen-ui-tweak-unknown-key' };
      }
      if (typeof value.value !== 'boolean') return { ok: false, reason: 'gen-ui-tweak-toggle-invalid' };
      return { ok: true, value: { ...base.value, type: 'toggle', value: value.value } };
    }
    case 'select': {
      if (!rejectGenUiUnknownKeys(value, ['id', 'label', 'reference', 'type', 'value', 'options'])) {
        return { ok: false, reason: 'gen-ui-tweak-unknown-key' };
      }
      if (typeof value.value !== 'string' || value.value.length > 120) return { ok: false, reason: 'gen-ui-tweak-select-value-invalid' };
      if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 12) {
        return { ok: false, reason: 'gen-ui-tweak-select-options-invalid' };
      }
      const options: GenUiSelectOption[] = [];
      for (const option of value.options) {
        if (typeof option === 'string') {
          if (!isGenUiNonEmptyString(option, 120)) return { ok: false, reason: 'gen-ui-tweak-select-options-invalid' };
          options.push({ label: option, value: option });
          continue;
        }
        if (!isGenUiPlainObject(option) || !rejectGenUiUnknownKeys(option, ['label', 'value'])) {
          return { ok: false, reason: 'gen-ui-tweak-select-options-invalid' };
        }
        if (!isGenUiNonEmptyString(option.label, 120) || typeof option.value !== 'string' || option.value.length > 120) {
          return { ok: false, reason: 'gen-ui-tweak-select-options-invalid' };
        }
        options.push({ label: option.label, value: option.value });
      }
      return { ok: true, value: { ...base.value, type: 'select', value: value.value, options } };
    }
    default:
      return { ok: false, reason: 'gen-ui-tweak-type-unsupported' };
  }
}

export function parseGenUiTweak(value: unknown): GenUiResult<GenUiTweak> {
  if (!isGenUiPlainObject(value)) return { ok: false, reason: 'gen-ui-tweak-not-object' };
  if (!rejectGenUiUnknownKeys(value, ['title', 'controls'])) return { ok: false, reason: 'gen-ui-tweak-unknown-key' };
  if (!isGenUiNonEmptyString(value.title, 120)) return { ok: false, reason: 'gen-ui-tweak-title-invalid' };
  if (!Array.isArray(value.controls) || value.controls.length < 1 || value.controls.length > GEN_UI_TWEAK_MAX_CONTROLS) {
    return { ok: false, reason: 'gen-ui-tweak-controls-invalid' };
  }
  const controls: GenUiTweakControl[] = [];
  const ids = new Set<string>();
  for (const raw of value.controls) {
    const parsed = parseTweakControl(raw);
    if (!parsed.ok) return parsed;
    const control = parsed.value;
    if (ids.has(control.id)) return { ok: false, reason: 'gen-ui-tweak-duplicate-id' };
    if (control.type === 'slider' && (control.min >= control.max || control.value < control.min || control.value > control.max)) {
      return { ok: false, reason: 'gen-ui-tweak-slider-range-invalid' };
    }
    if (control.type === 'select' && !control.options.some((option) => (typeof option === 'string' ? option : option.value) === control.value)) {
      return { ok: false, reason: 'gen-ui-tweak-select-value-invalid' };
    }
    ids.add(control.id);
    controls.push(control);
  }
  return { ok: true, value: { title: value.title, controls } };
}

export type GenUiTweakValues = Record<string, GenUiTweakValue>;

export interface GenUiStateEntry {
  readonly path: string;
  readonly state: GenUiWidgetState;
}

export interface GenUiStateChange {
  readonly target: GenUiStateTarget;
  readonly state: GenUiWidgetState | null;
}

/** 作用域键：workspace 身份（优先于路径）+ session，隔离同名路径的不同工作区/会话。 */
export function buildGenUiScopeKey(scope: GenUiScope): string {
  return JSON.stringify([scope.workspaceIdentity?.trim() || scope.workspacePath, scope.sessionId]);
}

/** 状态键：作用域键 + 页面路径。 */
export function buildGenUiStateKey(target: GenUiStateTarget): string {
  return JSON.stringify([buildGenUiScopeKey(target), target.path]);
}

/**
 * 构建模型上下文块：按 path 排序、最多 100 条、总量 ≤64KiB 就停，只取 modelContent。
 * 输出包在 `<untrusted_gen_ui_state>` 内，并把 `<` 转义为 `\u003c`——注入隔离，
 * 使 Widget 状态无法伪造闭合标签把内容顶出不可信区。
 */
export function buildGenUiModelContext(entries: readonly GenUiStateEntry[]): string {
  const selected: Array<{ path: string; state: unknown }> = [];
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path)).slice(0, GEN_UI_STATE_MAX_ENTRIES);
  for (const entry of sorted) {
    const parsed = parseGenUiWidgetState(entry.state);
    if (!parsed.ok || parsed.value.modelContent === null) continue;
    const next = { path: entry.path, state: parsed.value.modelContent };
    if (genUiByteLength(JSON.stringify([...selected, next])) > GEN_UI_CONTEXT_MAX_BYTES) break;
    selected.push(next);
  }
  return selected.length
    ? `<untrusted_gen_ui_state>\n${JSON.stringify(selected).replaceAll('<', '\\u003c')}\n</untrusted_gen_ui_state>`
    : '';
}

/**
 * 剥离模型上下文块：仅当末尾块能被完整解析为合法状态数组时才剥离，
 * 否则原样返回（防止把作者正文里形似标签的文本误删）。
 */
export function stripGenUiModelContext(content: string): string {
  const match = /\n\n<untrusted_gen_ui_state>\n([^]*?)\n<\/untrusted_gen_ui_state>\s*$/u.exec(content);
  if (!match) return content;
  try {
    const parsed: unknown = JSON.parse(match[1] ?? '');
    if (!Array.isArray(parsed) || parsed.length > GEN_UI_STATE_MAX_ENTRIES) return content;
    for (const entry of parsed) {
      if (!isGenUiPlainObject(entry) || !rejectGenUiUnknownKeys(entry, ['path', 'state']) || !isGenUiPath(entry.path)) {
        return content;
      }
    }
    return content.slice(0, match.index);
  } catch {
    return content;
  }
}
