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
}

/** MCP 工具 canonical 名：`mcp__<serverId>__<toolName>`（与 ZCode descriptor 一致）。 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
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
