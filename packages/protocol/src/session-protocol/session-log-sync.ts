// 一个文件=一种作用：会话事件日志的收敛机——seq 连续、快照权威、缺口重订阅。
//
// 移植自 ZCode `docs/v4-refactor/04-sync-and-recovery.md` 的收敛规则（b07 侧等价实现，
// 见 THIRD-PARTY-NOTICES.md）。四条不可让步的纪律：
//   1. 只按 seq 连续放行：seq ≤ 水位 = 重复/迟到 → 静默丢弃；seq > 水位+1 = 缺口 →
//      缓存并要求补齐，绝不带洞放行——放行会让下游把不连续的流当作完整流投影
//      （R1 审计 06 的根因）；
//   2. 快照是权威全量：收到即整体替换本地状态、重置基准，永不与本地合并；
//      快照也是唯一能跳出「无限重订阅」的收敛手段，补齐两轮仍缺口就升级为要快照；
//   3. 补齐只有一条在途（single flight）；结果按世代判定归属，迟到的应答一律丢弃；
//   4. 缓冲超限或补齐轮数耗尽 → 明确标记流不完整并停摆，绝不静默丢事件。
//
// 机器对载荷泛型（条目 TEntry / 快照 TSnapshot 各一份）：seq 连续性是协议级语义，
// 载荷含义由调用方解释——同一套规则既收敛 ZCode v1 的事件信封，也收敛 b07 会话协议
// v2 的 delta 条目。两者分开建模：事件条目与权威快照本来就不是同一个形状。

import {
  SESSION_RESYNC_MAX_ATTEMPTS,
  SESSION_RESYNC_PENDING_CAP,
  SESSION_RESYNC_REQUEST_TIMEOUT_MS,
  SESSION_RESYNC_RETRY_MS,
} from './session-limits.js';

/** 补齐请求的基准：seq=已连续应用到的水位；logEpoch 缺失=调用方不知道分支。 */
export interface SessionLogBase {
  readonly seq: number;
  readonly logEpoch?: string;
}

/** 一条待收敛的日志条目。 */
export interface SessionLogEntry<T> {
  readonly seq: number;
  readonly logEpoch?: string;
  readonly payload: T;
}

/** 权威快照：seq 是它对齐的水位（收到后本地水位即此值）。 */
export interface SessionLogSnapshot<S> {
  readonly seq: number;
  readonly logEpoch?: string;
  readonly snapshot: S;
}

/** 补齐应答的两种形态：快照（收敛到底）或条目批（从基准续播）。 */
export type SessionLogReplay<TEntry, TSnapshot = TEntry> =
  | { readonly kind: 'snapshot'; readonly snapshot: SessionLogSnapshot<TSnapshot> }
  | { readonly kind: 'entries'; readonly entries: readonly SessionLogEntry<TEntry>[] };

export interface SessionLogSyncOptions<TEntry, TSnapshot = TEntry> {
  /** 请求 (base.seq, now] 的补齐数据；forceSnapshot=true 时对端必须回快照。 */
  requestReplay(base: SessionLogBase, forceSnapshot: boolean): Promise<SessionLogReplay<TEntry, TSnapshot>>;
  /** 应用权威快照（调用方据此整体替换本地视图）。 */
  applySnapshot(snapshot: SessionLogSnapshot<TSnapshot>): void;
  /** 应用一条已确认连续的条目。 */
  applyEntry(entry: SessionLogEntry<TEntry>): void;
  /** 补齐无望（缓冲超限/轮数耗尽）：调用方据此提示用户，机器随即停摆。每轮只报一次。 */
  onIncomplete?(reason: string): void;
  /** 流从「不完整」被权威快照救回：调用方据此撤销提示。 */
  onRecovered?(): void;
  readonly retryMs?: number;
  readonly requestTimeoutMs?: number;
  readonly pendingCap?: number;
  readonly maxAttempts?: number;
}

export interface SessionLogSync<TEntry, TSnapshot = TEntry> {
  /** 追加一条条目（通知路径）。 */
  acceptEntry(entry: SessionLogEntry<TEntry>): void;
  /** 落一份权威快照：替换状态、重置基准、冲刷已缓存的连续条目。 */
  acceptSnapshot(snapshot: SessionLogSnapshot<TSnapshot>): void;
  /**
   * 锚定基准，仅在基准尚未建立（且未停摆）时生效：订阅 ACK 的补发批以
   * `批首 seq - 1` 调用，随后逐条 acceptEntry 才能被证明连续。
   * 与 noteServerSeq 分工——本方法定「批的起点」，noteServerSeq 只在对端领先时触发补齐。
   */
  bootstrap(base: SessionLogBase): void;
  /**
   * 对端宣告的最高水位。与 ZCode v4「订阅 ACK 不建立基准」刻意不同：
   * b07 的 session/subscribe ACK 里 eventSeq 是服务端订阅点水位，订阅点之前的
   * 事件不属于本视图（R1 审计 R2 的既有语义）；水位未建立时用它定起点，
   * 已建立且对端领先即视为有缺口、触发补齐。
   */
  noteServerSeq(seq: number): void;
  /** 宣告当前分支；换 logEpoch = 本地水位不可比，丢弃缓存并要求权威快照。 */
  noteEpoch(logEpoch: string): void;
  /** 会话重开：清空基准、缓冲与停摆标记，迟到应答按世代作废。 */
  reset(): void;
  /** 已连续应用到的水位（未建立基准时为 0）。 */
  readonly watermark: number;
  readonly hasBase: boolean;
  readonly incomplete: boolean;
  readonly bufferedCount: number;
}

/** 超时只放弃等待，不取消底层请求（对端可能不可取消）：迟到结果由世代护栏丢弃。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session-log-resync-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createSessionLogSync<TEntry, TSnapshot = TEntry>(
  options: SessionLogSyncOptions<TEntry, TSnapshot>,
): SessionLogSync<TEntry, TSnapshot> {
  const retryMs = options.retryMs ?? SESSION_RESYNC_RETRY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? SESSION_RESYNC_REQUEST_TIMEOUT_MS;
  const pendingCap = options.pendingCap ?? SESSION_RESYNC_PENDING_CAP;
  const maxAttempts = options.maxAttempts ?? SESSION_RESYNC_MAX_ATTEMPTS;

  /** 已连续应用到的水位；undefined = 基准未建立（此时任何条目都不可信）。 */
  let baseSeq: number | undefined;
  let baseEpoch: string | undefined;
  const buffered = new Map<number, SessionLogEntry<TEntry>>();
  let inFlight = false;
  /** 世代：快照/重置/换分支时自增，据此丢弃迟到的补齐结果。 */
  let generation = 0;
  /** 下一轮补齐是否强制要快照。 */
  let forceSnapshot = false;
  let attempts = 0;
  let incomplete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function markIncomplete(reason: string): void {
    if (incomplete) return;
    incomplete = true;
    clearTimer();
    buffered.clear();
    options.onIncomplete?.(reason);
  }

  /** 水位之后连续缓存的条目按序放行；缓冲清空即视为补齐成功，重试计数归零。 */
  function flush(): void {
    if (baseSeq === undefined) return;
    let next = baseSeq + 1;
    while (buffered.has(next)) {
      const entry = buffered.get(next)!;
      buffered.delete(next);
      baseSeq = next;
      options.applyEntry(entry);
      next += 1;
    }
    if (buffered.size === 0) {
      attempts = 0;
      forceSnapshot = false;
    }
  }

  function acceptSnapshot(snapshot: SessionLogSnapshot<TSnapshot>): void {
    if (!Number.isInteger(snapshot.seq) || snapshot.seq < 0) return;
    const wasIncomplete = incomplete;
    incomplete = false;
    forceSnapshot = false;
    attempts = 0;
    clearTimer();
    // 先自增世代：本轮在途补齐的结果从此作废，避免快照之后又被迟到批覆盖。
    generation += 1;
    baseSeq = snapshot.seq;
    if (snapshot.logEpoch !== undefined) baseEpoch = snapshot.logEpoch;
    // 快照水位之下的缓存作废：那些内容快照里已经有了，再重放一次就是二次生效。
    for (const seq of [...buffered.keys()]) if (seq <= snapshot.seq) buffered.delete(seq);
    options.applySnapshot(snapshot);
    flush();
    if (wasIncomplete) options.onRecovered?.();
  }

  function acceptEntry(entry: SessionLogEntry<TEntry>): void {
    if (incomplete) return;
    if (!Number.isInteger(entry.seq) || entry.seq < 0) return;
    if (entry.logEpoch !== undefined && baseEpoch !== undefined && entry.logEpoch !== baseEpoch) {
      // 别的分支：本地水位与它不可比，要求权威快照重来，不猜测归属。
      forceSnapshot = true;
      void resync();
      return;
    }
    if (baseSeq === undefined) {
      // 基准未建立：条目无法证明连续性，先缓存等补齐，绝不先放行。
      buffered.set(entry.seq, entry);
      void resync();
      return;
    }
    if (entry.seq <= baseSeq) return;
    if (entry.seq > baseSeq + 1) {
      buffered.set(entry.seq, entry);
      void resync();
      return;
    }
    baseSeq = entry.seq;
    options.applyEntry(entry);
    flush();
  }

  function bootstrap(base: SessionLogBase): void {
    if (baseSeq !== undefined || incomplete) return;
    if (!Number.isInteger(base.seq) || base.seq < 0) return;
    baseSeq = base.seq;
    if (base.logEpoch !== undefined) baseEpoch = base.logEpoch;
    flush();
  }

  function scheduleRetry(): void {
    if (timer !== undefined || incomplete || buffered.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void resync();
    }, retryMs);
  }

  async function resync(): Promise<void> {
    if (inFlight || incomplete) return;
    if (attempts >= maxAttempts) {
      markIncomplete('session-log-resync-attempts-exhausted');
      return;
    }
    inFlight = true;
    attempts += 1;
    const gen = generation;
    const base: SessionLogBase = {
      seq: baseSeq ?? 0,
      ...(baseEpoch === undefined ? {} : { logEpoch: baseEpoch }),
    };
    const wantSnapshot = forceSnapshot;
    try {
      const replay = await withTimeout(options.requestReplay(base, wantSnapshot), requestTimeoutMs);
      if (gen !== generation || incomplete) return;
      if (replay.kind === 'snapshot') {
        acceptSnapshot(replay.snapshot);
        return;
      }
      // 基准尚未建立但对端从 base.seq+1 起续播：这条连续性由请求本身证明，
      // 锚定基准后才能放行——否则首轮补齐永远填不上「没有基准」这个洞。
      if (baseSeq === undefined && replay.entries.length > 0 && replay.entries[0].seq === base.seq + 1) {
        bootstrap(base);
      }
      for (const entry of replay.entries) acceptEntry(entry);
      if (gen !== generation || incomplete) return;
      if (buffered.size > 0) {
        // 补齐批仍填不上洞：这一轮就是 recovery 数据还缺 → 下一轮强制要快照。
        forceSnapshot = true;
        scheduleRetry();
      }
    } catch {
      // 补齐失败：保留缺口退避重试；轮数耗尽由下一次 resync 入口判定为无望。
      if (gen === generation && !incomplete) scheduleRetry();
    } finally {
      inFlight = false;
      if (buffered.size > pendingCap) markIncomplete('session-log-gap-unresolved');
    }
  }

  function noteServerSeq(seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) return;
    if (baseSeq === undefined) {
      baseSeq = seq;
      return;
    }
    if (seq > baseSeq) void resync();
  }

  function noteEpoch(logEpoch: string): void {
    if (baseEpoch === logEpoch) return;
    const firstBranch = baseEpoch === undefined;
    baseEpoch = logEpoch;
    if (firstBranch) return;
    // 换分支：旧水位作废，缓存里可能全是另一个分支的条目。
    generation += 1;
    baseSeq = undefined;
    buffered.clear();
    attempts = 0;
    forceSnapshot = true;
    void resync();
  }

  function reset(): void {
    clearTimer();
    buffered.clear();
    baseSeq = undefined;
    baseEpoch = undefined;
    incomplete = false;
    forceSnapshot = false;
    attempts = 0;
    inFlight = false;
    generation += 1;
  }

  return {
    acceptEntry,
    acceptSnapshot,
    bootstrap,
    noteServerSeq,
    noteEpoch,
    reset,
    get watermark() {
      return baseSeq ?? 0;
    },
    get hasBase() {
      return baseSeq !== undefined;
    },
    get incomplete() {
      return incomplete;
    },
    get bufferedCount() {
      return buffered.size;
    },
  };
}
