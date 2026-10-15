// 一个文件=一种作用：MCP App 沙箱手势 token 注册表——真实用户手势背书的 5 秒一次性凭证。
//
// 参照 ZCode feat/ui-plugin 的 pluginSandbox/registry.ts（PLUGIN_SANDBOX_USER_GESTURE_TTL_MS
// 与 markUserGesture / consumeUserGesture），裁剪到 b07 的渲染层沙箱宿主：
// - 只有真实用户交互才打标（mark）；应用脚本无法凭空造出手势；
// - consume 是一次性消费：无论新鲜与否都清空记录，不能重放；
// - 未打标 / 已消费 / 超时一律 false（fail-closed）；
// - 时钟可注入，便于用假时钟覆盖「过期」与「一次性」两条语义。
//
// 上游把它放在 main 进程的沙箱注册表里，因为那是 Electron 下沙箱生命周期的唯一 owner；
// b07 没有 main 进程，沙箱宿主在工作台渲染层，故 token 由本模块在渲染层持有。

/** 与上游一致：一次用户手势给 5 秒窗口（对齐 HTML transient activation），一次性消费。 */
export const MCP_APP_USER_GESTURE_TTL_MS = 5_000;

export interface McpAppGestureTokenRegistryOptions {
  /** 时间源；缺省 Date.now。测试注入假时钟即可覆盖过期与一次性语义。 */
  now?: () => number;
  /** 手势窗口；缺省 5 秒。 */
  ttlMs?: number;
}

/**
 * 手势 token 注册表：按实例标识（b07 用挂载实例 appInstanceId）持有「最近一次真实手势时刻」。
 * 与上游注册表同形——mark 打标、consume 一次性消费、forget 随实例销毁清理。
 */
export class McpAppGestureTokenRegistry {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly gestureAt = new Map<string, number>();

  constructor(options: McpAppGestureTokenRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? MCP_APP_USER_GESTURE_TTL_MS;
  }

  /** 真实用户手势到达：把该实例的 token 记为当前时刻（覆盖旧值，窗口重新起算）。 */
  mark(tokenId: string): void {
    this.gestureAt.set(tokenId, this.now());
  }

  /**
   * 一次性消费：返回 true = 本次特权操作被新鲜手势背书。
   * 未打标 / 已消费 / 超时都返回 false，且**无论结果如何都清空**该实例记录——不能重放。
   */
  consume(tokenId: string): boolean {
    const at = this.gestureAt.get(tokenId);
    if (at === undefined) return false;
    this.gestureAt.delete(tokenId);
    return this.now() - at <= this.ttlMs;
  }

  /** 实例销毁：丢弃其 token（未打标则无操作）。 */
  forget(tokenId: string): void {
    this.gestureAt.delete(tokenId);
  }

  /** 当前持有 token 的实例数（测试与诊断用）。 */
  get size(): number {
    return this.gestureAt.size;
  }

  clear(): void {
    this.gestureAt.clear();
  }
}
