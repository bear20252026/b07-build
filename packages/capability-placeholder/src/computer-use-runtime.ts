// 一个文件=一种作用：fail-closed 的计算机使用 / 桌面控制运行时（占位实现）。
//
// 照 ZCode `@zcode/zcode-cua` 的 `createComputerUseRuntime` 范式：**API 形状
// 完整**（调用方现在就能照着类型写代码），但**每一个运行时面都报告 unavailable
// 并失败关闭**——
//   - `execute` 永远返回 `isError: true` 的不可用结果，绝不静默成功；
//   - `closeSession` / `dispose` 是空操作：不抛错，也不假装成功（无返回载荷）。

import { CAPABILITY_UNAVAILABLE_TEXT } from './placeholder-marker.js';

/** 一次计算机使用调用所处的会话上下文（与上游同形的最小字段集）。 */
export interface ComputerUseRuntimeContext {
  readonly sessionId: string;
  readonly runtimeScope: 'main' | 'subagent';
  readonly workspaceKey: string;
  readonly turnId?: string;
}

/** 一次计算机使用调用的输入（工具名 + 参数 + 上下文）。 */
export interface ComputerUseExecuteInput {
  readonly toolName: string;
  readonly arguments?: unknown;
  readonly context: ComputerUseRuntimeContext;
  readonly signal?: AbortSignal;
}

/** 与 MCP 工具结果同形：`content` + `isError`。占位运行时恒为 `isError: true`。 */
export interface ComputerUseToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError: true;
}

/** 计算机使用运行时契约：占位实现全拒，但形状与真实实现一致。 */
export interface ComputerUseRuntime {
  execute(input: ComputerUseExecuteInput): Promise<ComputerUseToolResult>;
  closeSession(context: ComputerUseRuntimeContext): Promise<void>;
  dispose(): Promise<void>;
}

/** 运行时装配选项（占位实现不读取任何选项，保留参数以便未来接线）。 */
export interface ComputerUseRuntimeOptions {
  readonly brokerSocketPath?: string;
}

/** 创建 fail-closed 的计算机使用运行时。选项一律忽略：没有可用能力可装配。 */
export function createComputerUseRuntime(_options: ComputerUseRuntimeOptions = {}): ComputerUseRuntime {
  return {
    async execute(_input: ComputerUseExecuteInput): Promise<ComputerUseToolResult> {
      return { content: [{ type: 'text', text: CAPABILITY_UNAVAILABLE_TEXT }], isError: true };
    },
    // 空操作：既不抛错也不返回「已关闭」之类的成功假象。
    async closeSession(_context: ComputerUseRuntimeContext): Promise<void> {},
    async dispose(): Promise<void> {},
  };
}
