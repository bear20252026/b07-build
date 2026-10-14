// 一个文件=一种作用：MCP App 实例租约——工具请求与结果的代际绑定。
//
// 参照 ZCode feat/ui-plugin 的实例生命周期设计（mcp-ui/instances.ts 的
// runtimeId/generation/token 模型）裁剪出宿主侧最小状态机：
// - iframe 每次（重新）加载都 rotate() 出新代际；
// - 工具请求入账时代际随之固定；
// - 结果回投前 deliver() 校验代际——插件切换/页面导航后，旧实例的迟到结果
//   绝不会投递到新实例（R1 审计 R4-03 的跨插件结果错投）。

export class McpAppInstanceLease {
  private generation = 0;
  private readonly pending = new Map<string, number>();

  /** iframe（重新）加载：递增代际，旧代际的全部未决请求立即失效并清空。 */
  rotate(): number {
    this.generation += 1;
    this.pending.clear();
    return this.generation;
  }

  get current(): number {
    return this.generation;
  }

  /** 请求入账：返回该请求绑定的代际。 */
  issue(toolCallId: string): number {
    this.pending.set(toolCallId, this.generation);
    return this.generation;
  }

  /**
   * 结果回投前校验并消耗记录：仅当代际仍为当前代际时放行。
   * 返回 false = 请求属于旧实例或从未入账，结果必须丢弃。
   */
  deliver(toolCallId: string): boolean {
    const generation = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    return generation !== undefined && generation === this.generation;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
