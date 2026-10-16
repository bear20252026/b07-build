// 一个文件=一种作用：Hook 链执行器（顺序执行、fail-closed、可解释）。
//
// 消费 `hook-registry.ts` 筛出的清单，按注册顺序跑 handler 并聚合结果。
//
// 设计研读自 Claude Code 还原源码 `src/utils/hooks.ts` 的 `executePreToolHooks` /
// `executePostToolHooks` 与 `types/hooks.ts` 的 `syncHookResponseSchema`。上游的
// handler 是外部进程或 LLM，故有超时、异步、退出码等机制；b07 这一步先收敛为
// **同步纯函数 handler**——这样执行不可观测地挂起，也就不需要超时预算。等到真的
// 接外部命令时，超时与沙箱应当作为**新的执行器实现**加入，而不是在这里预留空壳。
//
// ## 四条纪律
//
// 1. **顺序执行**：Hook 之间有先后语义（后一个能看到前一个改写后的入参），
//    并发跑会让结果不确定。
// 2. **阻塞即停**：任一 Hook 返回 Block，后续 Hook 不再运行——已经决定拦下了，
//    再跑别的只会产生副作用。
// 3. **改写可叠加**：Modify 的结果作为下一个 Hook 的输入，最终改写生效。
// 4. **异常即阻塞**（fail-closed）：handler 抛错不得被当作"放行"。策略层出错时
//    放行是危险的默认值，必须收敛为阻塞。

import type {
  HookChainResult,
  HookEvent,
  HookInvocation,
  HookRegistration,
} from './hook-contract.js';

/** 按事件与工具名筛 Hook 的函数签名（与 `HookRegistry.matching` 同形）。 */
export type HookSelector = (
  event: HookEvent,
  toolName: string | undefined,
) => readonly HookRegistration[];

/** 当前入参的可变载体，供链内传递改写结果。 */
type MutableInput = Record<string, unknown>;

/**
 * 执行一次 Hook 链。
 *
 * @param selector 由注册表提供的筛选函数。传入函数而非注册表本身，是为了让执行器
 *   不依赖具体注册实现——测试可以直接喂一个假的清单。
 * @param event 本次触发的事件。
 * @param invocation 基础调用信息。`toolInput` 会在链内被 Modify 改写。
 * @returns 聚合结果。**永远返回**，不抛异常——异常已收敛为 Block。
 */
export function executeHookChain(
  selector: HookSelector,
  event: HookEvent,
  invocation: HookInvocation,
): HookChainResult {
  const candidates = selector(event, invocation.toolName);

  // 尚未被改写时，resolvedInput 保持与入参同一个引用；一经改写就换成新对象，
  // 避免下游共享可变状态。
  let resolvedInput: Readonly<Record<string, unknown>> | undefined = invocation.toolInput;
  const contextParts: string[] = [];
  const appliedHookIds: string[] = [];
  const skippedHookIds: string[] = [];

  for (const registration of candidates) {
    // 每个 Hook 看到的是**截至当前**的入参（可能已被前一个 Hook 改写）。
    const currentInvocation: HookInvocation = {
      ...invocation,
      toolInput: resolvedInput,
    };

    let outcome;
    try {
      outcome = registration.handler(currentInvocation);
    } catch (error) {
      // fail-closed：handler 抛错 → 阻塞。放行会把"策略没跑成"变成"策略通过"。
      appliedHookIds.push(registration.id);
      return {
        blocked: true,
        blockReason: `hook-error:${registration.id}:${errorMessage(error)}`,
        resolvedInput,
        appliedHookIds,
        skippedHookIds,
        // 刻意不返回 additionalContext：已阻塞，注入上下文语义混乱。
      };
    }

    switch (outcome.kind) {
      case 'Abstain':
        skippedHookIds.push(registration.id);
        continue;

      case 'Allow':
        appliedHookIds.push(registration.id);
        if (outcome.additionalContext !== undefined) {
          contextParts.push(outcome.additionalContext);
        }
        continue;

      case 'Modify': {
        appliedHookIds.push(registration.id);
        // 合并而非替换：Hook 通常只想改一两个字段，整体替换会丢掉其它字段。
        const merged: MutableInput = { ...(resolvedInput ?? {}), ...outcome.updatedInput };
        resolvedInput = merged;
        if (outcome.additionalContext !== undefined) {
          contextParts.push(outcome.additionalContext);
        }
        continue;
      }

      case 'Block':
        appliedHookIds.push(registration.id);
        // 阻塞即停：后续 Hook 不再运行。
        return {
          blocked: true,
          blockReason: outcome.reason,
          resolvedInput,
          appliedHookIds,
          skippedHookIds,
        };
    }
  }

  return {
    blocked: false,
    resolvedInput,
    additionalContext: contextParts.length > 0 ? contextParts.join('\n\n') : undefined,
    appliedHookIds,
    skippedHookIds,
  };
}

/** 从任意抛出物中取出可读消息，绝不把整个对象字符串化（可能含大对象）。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'unknown';
}
