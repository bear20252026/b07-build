// 一个文件=一种作用：工具声明契约与注册表（ToolDescriptor / ToolRegistry）。
//
// 借鉴 ZCode `core/src/tool/registry.ts` 的 xToolEntry 模式：工具在执行前
// 以声明式元数据注册，审批、预算、可观测性都从同一份契约读数，而不是在
// 各调用点 ad hoc 传 riskFor 之类的函数。三处硬规则：
//   1. 新增能力必须先经 protocol 的 Capability 联合类型声明，不能以任意
//      字符串绕过策略层（与 ToolRef 的显式声明一体）；
//   2. canonical 名唯一；alias 只为兼容旧名存在，且注册时冲突即拒绝——
//      防止 alias 把调用路由到错误的权限或 handler（ZCode 同款防串权）；
//   3. 描述符是不可变数据：运行期不改写风险/预算，改契约必须走新版本注册。

import type { Capability, RiskLevel } from './types.js';

/** 副作用作用域：审批与审计叙事都按它分级（none=纯读，workspace=本工作区，external=外部世界）。 */
export type SideEffectScope = 'none' | 'workspace' | 'external';

export interface ToolDescriptor {
  /** canonical 工具名（MCP 工具用 `mcp__<server>__<tool>`，见 mcpToolName）。 */
  readonly name: string;
  readonly capability: Capability;
  /** 缺省风险等级；调用点可以按参数提高，不能低于此。 */
  readonly defaultRisk: RiskLevel;
  /**
   * **工具级**缺省只读声明。
   *
   * 表示"这个工具在一般情况下是否只读"。它不足以表达逐命令/逐标志的差异——
   * 例如 shell 工具：`ls` 只读，`rm -rf` 写入，同一个工具名两者都干。要表达这种
   * 差异必须用 [`ToolDescriptor.isReadOnly`]。
   *
   * 当 `isReadOnly` 存在时本字段**不再被用于判定**，只作为无入参上下文时的兜底
   * 与文档用途；判定请一律走 `isToolReadOnlyWith(descriptor, input)`。
   */
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly sideEffectScope: SideEffectScope;
  /** 单次结果预算（字符）；超限结果由调用方裁剪，绝不整段放行。 */
  readonly resultBudgetChars: number;
  /** 单次执行超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 是否允许并发执行；false 时同工具调用串行。 */
  readonly concurrentSafe: boolean;
  readonly description?: string;
  /**
   * **按入参**判定本次调用是否只读。
   *
   * 设计研读自 Claude Code 的 `Tool.isReadOnly(input)`：把"只读"从工具的**静态属性**
   * 变成**函数**，从而能表达"逐命令 / 逐标志只读判定"（基线 1 原文要求）——
   * `Bash("ls")` 只读、`Bash("rm -rf /")` 写入。
   *
   * 实现约束（与上游一致）：
   * - **必须纯**：只读 `input`，不得有副作用，不得依赖外部可变状态。判定会被
   *   策略层在每次调用前执行，不确定性会让审批结果无法复现。
   * - **必须 fail-closed**：无法确定时返回 `false`（当作写入）。**默认缺省即
   *   `false`**——上游 `TOOL_DEFAULTS.isReadOnly` 也是 `() => false`（注释原文
   *   "assume writes"）。宁可多要一次审批，也不要漏放一次写入。
   * - **不得抛异常**：抛错会被判定为"策略层故障"。若确实需要拒绝，返回 `false`
   *   让后续权限链给出结论，而不是在这里抛。
   *
   * 可选：未提供时退化为 `readOnly` 静态字段。这样既有工具描述符无需改动。
   */
  readonly isReadOnly?: (input: Readonly<Record<string, unknown>>) => boolean;
}

/**
 * 判定一次具体调用是否只读：优先用按入参的函数，退化为静态声明。
 *
 * **这是唯一的判定入口**——不要在调用点直接读 `descriptor.readOnly`，否则
 * 那些提供了 `isReadOnly` 的工具会被静默按静态值处理（多半是把写入当只读，
 * 或反之），而这类错误不会报错，只会表现为"审批行为不符合预期"。
 *
 * 三条 fail-closed 纪律：
 * 1. `isReadOnly` 抛异常 → 视为写入（`false`），不向上传播。策略层故障绝不能被
 *    当作"只读放行"。
 * 2. 返回值非布尔（JS 调用方可能给 `undefined`/`'true'` 等）→ 视为写入。
 * 3. 描述符缺失 → 视为写入。
 */
export function isToolReadOnlyWith(
  descriptor: Pick<ToolDescriptor, 'readOnly' | 'isReadOnly'> | undefined,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (descriptor === undefined) return false;

  if (descriptor.isReadOnly !== undefined) {
    try {
      const verdict = descriptor.isReadOnly(input);
      // 严格等于 true：`'true'`、`1`、`undefined` 都不算只读。
      return verdict === true;
    } catch {
      // 策略层故障 → 当作写入。绝不能因故障而放行。
      return false;
    }
  }

  return descriptor.readOnly === true;
}

/** MCP 工具 canonical 名：`mcp__<serverId>__<toolName>`（与 ZCode descriptor 一致）。 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/**
 * canonical 名反向解析：`mcp__<serverId>__<toolName>` → { serverId, toolName }。
 * 与 mcpToolName round-trip；server/tool 名里的下划线由 sanitizeMcpName 折叠，
 * 因此按「mcp__ 前缀 + 剩余部分第一个 `__`」分隔（server 段在前，与
 * mcpToolName 的拼接顺序一致）。不是该形态的名字返回 undefined——调用方必须
 * fail-closed，不得猜测分段。
 */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return undefined;
  const serverId = rest.slice(0, separator);
  const toolName = rest.slice(separator + 2);
  if (serverId.length === 0 || toolName.length === 0) return undefined;
  return { serverId, toolName };
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ToolContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function assertToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ToolContractError('tool-name-invalid', `工具名无效：${name}`);
  }
}

export class ToolRegistry {
  private readonly canonical = new Map<string, ToolDescriptor>();
  private readonly aliases = new Map<string, string>();

  /** 注册 canonical 工具；重名注册直接抛错（契约不允许静默覆盖）。 */
  register(descriptor: ToolDescriptor, alsoKnownAs: readonly string[] = []): void {
    assertToolName(descriptor.name);
    if (this.canonical.has(descriptor.name) || this.aliases.has(descriptor.name)) {
      throw new ToolContractError('tool-name-conflict', `工具名已被注册：${descriptor.name}`);
    }
    for (const alias of alsoKnownAs) {
      assertToolName(alias);
      // alias 冲突即拒：宁可以旧名找不到，也不能把调用路由到另一个工具。
      if (this.canonical.has(alias) || this.aliases.has(alias)) {
        throw new ToolContractError('tool-alias-conflict', `alias 已被占用：${alias}`);
      }
    }
    this.canonical.set(descriptor.name, descriptor);
    for (const alias of alsoKnownAs) this.aliases.set(alias, descriptor.name);
  }

  /** 按 canonical 名或 alias 解析；未注册返回 undefined。 */
  resolve(name: string): ToolDescriptor | undefined {
    const direct = this.canonical.get(name);
    if (direct) return direct;
    const target = this.aliases.get(name);
    return target === undefined ? undefined : this.canonical.get(target);
  }

  /** 解析或抛错：执行路径上不应该带着未注册的工具名前进。 */
  require(name: string): ToolDescriptor {
    const descriptor = this.resolve(name);
    if (!descriptor) {
      throw new ToolContractError('tool-not-registered', `工具未注册：${name}`);
    }
    return descriptor;
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  descriptors(): readonly ToolDescriptor[] {
    return [...this.canonical.values()];
  }
}
