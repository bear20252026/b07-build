// 一个文件=一种作用：浏览器能力的 MCP 工具面契约（工具清单 + 参数 schema + 注册表）。
//
// 方向说明：本文件把「宿主能力 → 以 MCP server 暴露给 Agent」这一侧的工具面
// 定成契约，与 b07 既有的 MCP Apps（「沙箱应用 → 调用宿主工具」）是**互补的
// 另一个方向**。本构建没有浏览器自动化引擎，因此契约完整、运行期全拒：工具名、
// 参数 schema、副作用标注现在就写清楚，但没有任何后端能真正执行（拒答见
// `browser-tool-handlers.ts`）。
//
// 工具面按三类切分（会话生命周期 / 只读观测 / 导航与交互）。分组只表达用途，
// **副作用标注逐工具按语义定**，并以「最强副作用为准」：一个工具若同时含只读与
// 写入两种动作（如 tabs 的 list 与 new/close），一律按写入标注——标注错误比缺
// 工具更危险，被误标为只读的写工具会绕过审批直接执行。
//
// 标注规则（单一出口，避免逐条手写漂移）：
//   - 只读工具：readOnly: true、sideEffectScope: 'none'、defaultRisk: 'low'、可并发；
//   - 有外部副作用的工具：readOnly: false、sideEffectScope: 'external'、
//     defaultRisk: 'medium'、同工具串行（concurrentSafe: false）。

import { ToolRegistry, mcpToolName, type RiskLevel, type ToolDescriptor } from '@awo/protocol';

import { canUseBrowserToolSurface } from './capability-predicates.js';
import { BROWSER_TOOL_UNAVAILABLE_CODE, BROWSER_TOOL_UNAVAILABLE_TEXT } from './placeholder-marker.js';

/** MCP server 段名：canonical 工具名形如 `mcp__browser__<tool>`。 */
export const BROWSER_TOOL_SERVER_ID = 'browser';

/**
 * 全部工具的 canonical 名（`mcp__<serverId>__<toolName>`，见 protocol 的 mcpToolName）。
 * 工具名内部的单下划线不破坏 round-trip：parseMcpToolName 按 server 段后的第一个
 * `__` 切分，server 段固定为不含下划线的 `browser`。
 */
export const BROWSER_TOOL_NAMES = {
  createSession: mcpToolName(BROWSER_TOOL_SERVER_ID, 'create_session'),
  listSessions: mcpToolName(BROWSER_TOOL_SERVER_ID, 'list_sessions'),
  closeSession: mcpToolName(BROWSER_TOOL_SERVER_ID, 'close_session'),
  snapshot: mcpToolName(BROWSER_TOOL_SERVER_ID, 'snapshot'),
  takeScreenshot: mcpToolName(BROWSER_TOOL_SERVER_ID, 'take_screenshot'),
  navigate: mcpToolName(BROWSER_TOOL_SERVER_ID, 'navigate'),
  click: mcpToolName(BROWSER_TOOL_SERVER_ID, 'click'),
  type: mcpToolName(BROWSER_TOOL_SERVER_ID, 'type'),
  fillForm: mcpToolName(BROWSER_TOOL_SERVER_ID, 'fill_form'),
  pressKey: mcpToolName(BROWSER_TOOL_SERVER_ID, 'press_key'),
  selectOption: mcpToolName(BROWSER_TOOL_SERVER_ID, 'select_option'),
  waitFor: mcpToolName(BROWSER_TOOL_SERVER_ID, 'wait_for'),
  tabs: mcpToolName(BROWSER_TOOL_SERVER_ID, 'tabs'),
} as const;

/** 工具面的三个用途分组。 */
export type BrowserToolCategory = 'session-lifecycle' | 'read-only-observation' | 'navigation-interaction';

/** 参数取值类型（与 MCP 输入 schema 的粗略映射，够工具面清单自描述即可）。 */
export type BrowserToolParameterType = 'string' | 'number' | 'boolean' | 'string-list' | 'form-fields';

/** 单个参数的声明（名称 / 类型 / 是否必填 / 说明）。 */
export interface BrowserToolParameter {
  readonly name: string;
  readonly type: BrowserToolParameterType;
  readonly required: boolean;
  readonly description: string;
}

/** 一个工具的完整声明：canonical 名 + 分组 + 执行契约描述符 + 参数 schema。 */
export interface BrowserToolSpec {
  readonly name: string;
  readonly category: BrowserToolCategory;
  readonly descriptor: ToolDescriptor;
  readonly parameters: readonly BrowserToolParameter[];
}

/** 只读工具的统一标注：不改外部世界，作用域 none，风险 low，可并发。 */
function readOnlyBrowserToolDescriptor(
  name: string,
  description: string,
  resultBudgetChars: number,
  timeoutMs: number,
): ToolDescriptor {
  return {
    name,
    capability: 'browser.control',
    defaultRisk: 'low',
    readOnly: true,
    destructive: false,
    sideEffectScope: 'none',
    resultBudgetChars,
    timeoutMs,
    concurrentSafe: true,
    description,
  };
}

/** 有外部副作用的工具的统一标注：非只读，作用域 external，风险 medium，同工具串行。 */
function externalBrowserToolDescriptor(
  name: string,
  description: string,
  resultBudgetChars: number,
  timeoutMs: number,
  defaultRisk: RiskLevel = 'medium',
): ToolDescriptor {
  return {
    name,
    capability: 'browser.control',
    defaultRisk,
    readOnly: false,
    destructive: false,
    sideEffectScope: 'external',
    resultBudgetChars,
    timeoutMs,
    concurrentSafe: false,
    description,
  };
}

const SESSION_ID: BrowserToolParameter = {
  name: 'sessionId',
  type: 'string',
  required: true,
  description: '浏览会话 id（由 create_session 返回）。',
};

/** 浏览器工具面的完整清单（13 个工具，按三类分组）。 */
export const BROWSER_TOOL_SPECS: readonly BrowserToolSpec[] = [
  // —— 会话生命周期 ——
  {
    name: BROWSER_TOOL_NAMES.createSession,
    category: 'session-lifecycle',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.createSession,
      '创建一个可被 Agent 控制的临时浏览会话；可选背景 profile 以复用存储。',
      4_000,
      30_000,
    ),
    parameters: [
      { name: 'profileName', type: 'string', required: false, description: '可选的背景 profile 名，用于复用持久化浏览存储。' },
    ],
  },
  {
    name: BROWSER_TOOL_NAMES.listSessions,
    category: 'session-lifecycle',
    descriptor: readOnlyBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.listSessions,
      '列出当前可供 Agent 使用的浏览会话。',
      16_000,
      10_000,
    ),
    parameters: [],
  },
  {
    name: BROWSER_TOOL_NAMES.closeSession,
    category: 'session-lifecycle',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.closeSession,
      '结束一个由 Agent 控制的浏览会话。',
      4_000,
      30_000,
    ),
    parameters: [SESSION_ID],
  },

  // —— 只读观测 ——
  {
    name: BROWSER_TOOL_NAMES.snapshot,
    category: 'read-only-observation',
    descriptor: readOnlyBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.snapshot,
      '抓取当前页面结构：元数据、可见正文文本与截图引用。',
      128_000,
      30_000,
    ),
    parameters: [SESSION_ID],
  },
  {
    name: BROWSER_TOOL_NAMES.takeScreenshot,
    category: 'read-only-observation',
    descriptor: readOnlyBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.takeScreenshot,
      '抓取浏览会话的最新截图。',
      512_000,
      30_000,
    ),
    parameters: [SESSION_ID],
  },

  // —— 导航与交互 ——
  // 注：wait_for 虽归在交互组，但只观察页面状态、不改外部世界，故按只读标注。
  {
    name: BROWSER_TOOL_NAMES.navigate,
    category: 'navigation-interaction',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.navigate,
      '把浏览会话导航到指定 HTTP(S) 地址。',
      8_000,
      60_000,
    ),
    parameters: [SESSION_ID, { name: 'url', type: 'string', required: true, description: '目标地址（http/https）。' }],
  },
  {
    name: BROWSER_TOOL_NAMES.click,
    category: 'navigation-interaction',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.click,
      '按 CSS 选择器、可见文本或坐标点击页面元素。',
      8_000,
      30_000,
    ),
    parameters: [
      SESSION_ID,
      { name: 'selector', type: 'string', required: false, description: 'CSS 选择器。' },
      { name: 'text', type: 'string', required: false, description: '可见文本。' },
      { name: 'x', type: 'number', required: false, description: '横坐标。' },
      { name: 'y', type: 'number', required: false, description: '纵坐标。' },
    ],
  },
  {
    name: BROWSER_TOOL_NAMES.type,
    category: 'navigation-interaction',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.type,
      '向当前焦点或指定选择器输入文本；submit 为真时随后按回车。',
      8_000,
      30_000,
    ),
    parameters: [
      SESSION_ID,
      { name: 'text', type: 'string', required: true, description: '要输入的文本。' },
      { name: 'selector', type: 'string', required: false, description: '目标输入的 CSS 选择器。' },
      { name: 'submit', type: 'boolean', required: false, description: '输入后是否按回车。' },
    ],
  },
  {
    name: BROWSER_TOOL_NAMES.fillForm,
    category: 'navigation-interaction',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.fillForm,
      '按 CSS 选择器批量填充多个表单字段。',
      16_000,
      60_000,
    ),
    parameters: [
      SESSION_ID,
      { name: 'fields', type: 'form-fields', required: true, description: '字段数组，每项含 selector 与 value。' },
    ],
  },
  {
    name: BROWSER_TOOL_NAMES.pressKey,
    category: 'navigation-interaction',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.pressKey,
      '按下一个键，例如 Enter、Escape、Tab 或 Control+A。',
      4_000,
      30_000,
    ),
    parameters: [SESSION_ID, { name: 'key', type: 'string', required: true, description: '键名（可含组合键）。' }],
  },
  {
    name: BROWSER_TOOL_NAMES.selectOption,
    category: 'navigation-interaction',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.selectOption,
      '在指定 select 元素中选择若干选项值。',
      8_000,
      30_000,
    ),
    parameters: [
      SESSION_ID,
      { name: 'selector', type: 'string', required: true, description: 'select 元素的 CSS 选择器。' },
      { name: 'values', type: 'string-list', required: true, description: '要选中的选项值列表。' },
    ],
  },
  {
    name: BROWSER_TOOL_NAMES.waitFor,
    category: 'navigation-interaction',
    descriptor: readOnlyBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.waitFor,
      '等待可见文本、URL 形态或一段超时。只观察页面状态，不改外部世界。',
      8_000,
      60_000,
    ),
    parameters: [
      SESSION_ID,
      { name: 'text', type: 'string', required: false, description: '等待出现的可见文本。' },
      { name: 'url', type: 'string', required: false, description: '等待匹配的 URL 形态。' },
      { name: 'timeoutMs', type: 'number', required: false, description: '最长等待毫秒数。' },
    ],
  },
  {
    name: BROWSER_TOOL_NAMES.tabs,
    category: 'navigation-interaction',
    descriptor: externalBrowserToolDescriptor(
      BROWSER_TOOL_NAMES.tabs,
      '列出、新建、切换或关闭浏览会话中的标签页。',
      16_000,
      30_000,
    ),
    parameters: [
      SESSION_ID,
      { name: 'action', type: 'string', required: false, description: 'list / new / select / close。' },
      { name: 'index', type: 'number', required: false, description: '标签页下标。' },
      { name: 'url', type: 'string', required: false, description: '新建标签页时的目标地址。' },
    ],
  },
];

/** 按 canonical 名取工具声明；未登记返回 undefined（调用方据此 fail-closed）。 */
export function findBrowserToolSpec(name: string): BrowserToolSpec | undefined {
  return BROWSER_TOOL_SPECS.find((spec) => spec.name === name);
}

/** 注册全部浏览器工具；重名由 ToolRegistry 直接拒绝（契约不允许静默覆盖）。 */
export function createBrowserToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const spec of BROWSER_TOOL_SPECS) registry.register(spec.descriptor);
  return registry;
}

/** 工具面可用性（恒 false）：引用谓词，令「不可用」有单一事实源。 */
export const BROWSER_TOOL_SURFACE_AVAILABLE = canUseBrowserToolSurface();

/**
 * 浏览器工具面：可被查询/列举，且**不可用状态在调用之前就可被外部观察到**
 * （`available === false` + 稳定错误码 + 可读原因），而不是只在调用时才失败。
 */
export interface BrowserToolSurface {
  readonly serverId: string;
  readonly available: false;
  readonly unavailableCode: string;
  readonly unavailableReason: string;
  readonly specs: readonly BrowserToolSpec[];
  readonly registry: ToolRegistry;
}

/** 装配浏览器工具面（契约 + 注册表 + 不可用状态）。 */
export function createBrowserToolSurface(): BrowserToolSurface {
  return {
    serverId: BROWSER_TOOL_SERVER_ID,
    available: BROWSER_TOOL_SURFACE_AVAILABLE,
    unavailableCode: BROWSER_TOOL_UNAVAILABLE_CODE,
    unavailableReason: BROWSER_TOOL_UNAVAILABLE_TEXT,
    specs: BROWSER_TOOL_SPECS,
    registry: createBrowserToolRegistry(),
  };
}
