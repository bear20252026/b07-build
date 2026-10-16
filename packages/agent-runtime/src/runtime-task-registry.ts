// 一个文件=一种作用：运行期任务台账实现（登记 / 观察 / 后台化 / 消息投递 / 代际围栏）。纯内存，零 IO。
//
// 设计约束、上游来源与许可见 `runtime-task-contract.ts` 模块头。这里只记实现层面的三条纪律：
//
// 1. **等待者不泄漏**：每个 waiter 在结算时都会摘掉自己的 abort 监听器，
//    被 abort 时也会从集合里摘掉自己。集合空了就把 key 删掉，否则长会话里
//    `Map<string, Set>` 会随任务 id 无限增长。
// 2. **结算只发生在状态真正跨越边界时**：`resolveTerminalWaiters` 只在
//    `isTerminalRuntimeTask()` 为真时调用；`resolveBackgroundWaiters` 只在
//    `isBackgrounded` 真正变为 `true` 时调用。`update()` 里用"前后状态对比"
//    而不是"目标状态判定"，避免把一个本来就终态的任务反复结算（等待者拿到的是
//    最后一次写入的快照，而非第一次跨越的那次）。
// 3. **代际在注册点盖章**：`register()` 写入 `branchGeneration` 后**任何 patch 都改不了它**
//    （`applyRuntimeTaskPatch` 不允许该字段）。这是围栏的有效性前提。

import {
  isTerminalRuntimeTask,
  isTerminalRuntimeTaskStatus,
  type RuntimeTaskPatch,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskQuery,
  type RuntimeTaskRegistration,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
  type RuntimeTaskWaitOptions,
} from './runtime-task-contract.js';

interface RuntimeTaskWaiter {
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  readonly reject: (error: unknown) => void;
  readonly resolve: (task: RuntimeTaskSnapshot | undefined) => void;
}

/**
 * 等待被 abort 时的拒绝原因。
 *
 * 优先保留调用方给的 `reason`（里面有它自己的上下文，丢掉它等于丢掉诊断线索）；
 * 只有在 `reason` 缺席时才自己造一个。
 *
 * **不要按"`reason === undefined`"来判缺席**：实测 `AbortController.abort()` 不带参数时，
 * `signal.reason` 自动填一个 `AbortError` DOMException（`message` 是英文的
 * "This operation was aborted"），并**不是** `undefined`。所以判据要同时看
 * "是不是 undefined" 与 "是不是那个自动填的 AbortError"。否则"调用方没给原因"
 * 这个情形永远走不到自己的文案分支——表现为一条对中文用户毫无意义的英文报错。
 */
function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason !== undefined && !isDefaultAbortReason(reason)) return reason;
  return new Error('运行期任务等待已被取消');
}

/** 是否是平台自动填的 AbortError（而非调用方显式传入的原因）。 */
function isDefaultAbortReason(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  return (reason as { name?: unknown }).name === 'AbortError';
}

function assertTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) {
    throw new Error('taskId 必须是 1-128 位安全标识符');
  }
}

/**
 * 应用补丁。
 *
 * **刻意不允许改 `taskId`/`type`/`branchGeneration`**：前两者是身份，改了等于换任务；
 * `branchGeneration` 是注册时固定下来的归属，允许改就等于把迟到完成围栏拆了。
 * 这三个字段即使出现在 patch 对象里也会被忽略——`RuntimeTaskPatch` 类型上就没有它们，
 * 这里再兜一次是因为 JS 调用方可以绕过类型。
 */
function applyRuntimeTaskPatch(
  current: RuntimeTaskSnapshot,
  patch: Record<string, unknown>,
  at: number,
): RuntimeTaskSnapshot {
  const next: RuntimeTaskSnapshot = {
    taskId: current.taskId,
    type: current.type,
    branchGeneration: current.branchGeneration,
    createdAt: current.createdAt,
    updatedAt: at,
    status: typeof patch.status === 'string' && patch.status !== '' ? (patch.status as RuntimeTaskSnapshot['status']) : current.status,
    label: 'label' in patch ? (patch.label as string | undefined) : current.label,
    isBackgrounded: 'isBackgrounded' in patch ? (patch.isBackgrounded as boolean | undefined) : current.isBackgrounded,
    stopInitiator: 'stopInitiator' in patch ? (patch.stopInitiator as RuntimeTaskSnapshot['stopInitiator']) : current.stopInitiator,
    resultSummary: 'resultSummary' in patch ? (patch.resultSummary as string | undefined) : current.resultSummary,
    errorMessage: 'errorMessage' in patch ? (patch.errorMessage as string | undefined) : current.errorMessage,
    usage: 'usage' in patch ? (patch.usage as RuntimeTaskSnapshot['usage']) : current.usage,
    metadata: 'metadata' in patch ? (patch.metadata as RuntimeTaskSnapshot['metadata']) : current.metadata,
  };
  return next;
}

/** 内存实现。用于本地开发与测试；持久化适配器可在不触碰等待语义的前提下替换它。 */
export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private activeGeneration = 0;
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly deliveredMessageIds = new Set<string>();
  private readonly pendingMessages = new Map<string, RuntimeTaskPendingMessage[]>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  constructor(private readonly now: () => number = Date.now) {}

  all(): readonly RuntimeTaskSnapshot[] {
    return [...this.tasks.keys()].sort().map((taskId) => ({ ...this.tasks.get(taskId)! }));
  }

  query(filter: RuntimeTaskQuery = {}): readonly RuntimeTaskSnapshot[] {
    return this.all().filter((task) => {
      if (filter.type !== undefined && task.type !== filter.type) return false;
      if (filter.status !== undefined && task.status !== filter.status) return false;
      if (filter.terminal !== undefined && isTerminalRuntimeTask(task) !== filter.terminal) return false;
      if (filter.backgrounded !== undefined && (task.isBackgrounded === true) !== filter.backgrounded) return false;
      if (filter.branchGeneration !== undefined && task.branchGeneration !== filter.branchGeneration) return false;
      return true;
    });
  }

  get(taskId: string): RuntimeTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  register(registration: RuntimeTaskRegistration): RuntimeTaskSnapshot {
    assertTaskId(registration.taskId);
    if (this.tasks.has(registration.taskId)) {
      throw new Error(`运行期任务 ${registration.taskId} 已注册，拒绝覆盖`);
    }
    const at = this.now();
    const task: RuntimeTaskSnapshot = {
      taskId: registration.taskId,
      type: registration.type,
      status: registration.status ?? 'created',
      label: registration.label,
      // 注册点盖章：显式给的值优先，否则用当前代际。**这就是围栏的锚点**。
      branchGeneration: registration.branchGeneration ?? this.activeGeneration,
      isBackgrounded: undefined,
      stopInitiator: undefined,
      resultSummary: registration.resultSummary,
      errorMessage: registration.errorMessage,
      usage: registration.usage,
      createdAt: at,
      updatedAt: at,
      metadata: registration.metadata,
    };
    this.tasks.set(task.taskId, task);
    // 允许"注册即终态"：注册一个补记的已完成任务时，已经在等的观察者应当立刻被唤醒。
    this.resolveIfTerminal(task.taskId, task, task);
    return { ...task };
  }

  update(taskId: string, patch: RuntimeTaskPatch): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(taskId);
    if (!current) return undefined;
    const next = applyRuntimeTaskPatch(current, patch as Record<string, unknown>, this.now());
    this.tasks.set(taskId, next);
    this.resolveIfTerminal(taskId, next, current);
    this.resolveIfBackgrounded(taskId, next, current);
    return { ...next };
  }

  remove(taskId: string): void {
    this.tasks.delete(taskId);
    this.pendingMessages.delete(taskId);
    // 任务消失：等待者拿到 `undefined`（不是 reject）——"它不在了"是一个可判定的事实，
    // 不是异常。真正的异常只有"等待被取消"。
    this.resolveTerminalWaiters(taskId, undefined);
    this.resolveBackgroundWaiters(taskId, undefined);
  }

  requestBackground(taskId: string): boolean {
    const current = this.tasks.get(taskId);
    if (!current) return false;
    if (isTerminalRuntimeTask(current)) return false;
    // 已后台化时返回 false：返回值表达「这次调用改变了什么」，不表达「当前是不是后台态」。
    if (current.isBackgrounded === true) return false;
    const next = applyRuntimeTaskPatch(current, { isBackgrounded: true }, this.now());
    this.tasks.set(taskId, next);
    this.resolveBackgroundWaiters(taskId, next);
    return true;
  }

  setActiveBranchGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('分支代际必须是非负安全整数');
    }
    this.activeGeneration = generation;
  }

  activeBranchGeneration(): number {
    return this.activeGeneration;
  }

  waitForTerminal(taskId: string, options?: RuntimeTaskWaitOptions): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(taskId);
    if (!current) return Promise.resolve(undefined);
    if (isTerminalRuntimeTask(current)) return Promise.resolve({ ...current });
    return this.waitFor(this.terminalWaiters, taskId, options);
  }

  waitForBackgroundRequest(taskId: string, options?: RuntimeTaskWaitOptions): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(taskId);
    // 已终态的任务不会再被后台化：返回 `undefined` 而不是快照，让调用方一眼看出等错了。
    if (!current || isTerminalRuntimeTask(current)) return Promise.resolve(undefined);
    if (current.isBackgrounded === true) return Promise.resolve({ ...current });
    return this.waitFor(this.backgroundWaiters, taskId, options);
  }

  queueMessage(
    taskId: string,
    message: Omit<RuntimeTaskPendingMessage, 'queuedAt'> & { queuedAt?: number },
  ): RuntimeTaskSnapshot | undefined {
    if (!this.tasks.has(taskId)) return undefined;
    if (!message.id.trim()) throw new Error('消息 id 不能为空');
    if (!message.message.trim()) throw new Error('运行期任务消息正文不能为空');
    if (this.deliveredMessageIds.has(message.id)) {
      throw new Error(`运行期任务消息 ${message.id} 已投递，拒绝重复`);
    }
    const queued: RuntimeTaskPendingMessage = {
      id: message.id,
      message: message.message,
      summary: message.summary,
      isMeta: message.isMeta,
      origin: message.origin,
      queuedAt: message.queuedAt ?? this.now(),
    };
    const queue = this.pendingMessages.get(taskId) ?? [];
    queue.push(queued);
    this.pendingMessages.set(taskId, queue);
    this.deliveredMessageIds.add(queued.id);
    return { ...this.tasks.get(taskId)! };
  }

  drainMessages(taskId: string): readonly RuntimeTaskPendingMessage[] {
    const queue = this.pendingMessages.get(taskId);
    if (!queue || queue.length === 0) return [];
    this.pendingMessages.set(taskId, []);
    return queue.map((message) => ({ ...message }));
  }

  pendingMessageCount(taskId: string): number {
    return this.pendingMessages.get(taskId)?.length ?? 0;
  }

  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    taskId: string,
    options?: RuntimeTaskWaitOptions,
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    // 已经取消的 signal：**不注册 waiter**，直接 reject。注册再摘掉会在
    // resolve/reject 竞态里留下一个已 settle 的 waiter。
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise<RuntimeTaskSnapshot | undefined>((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, taskId, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(taskId);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(taskId, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfTerminal(
    taskId: string,
    next: RuntimeTaskSnapshot,
    previous: RuntimeTaskSnapshot,
  ): void {
    if (!isTerminalRuntimeTask(next)) return;
    // 已经是终态的任务被再次写入终态时不再重复结算——`previous` 判定保证
    // 结算只发生在**跨越边界**的那一次（等待者因此拿到的是跨越时的快照）。
    if (isTerminalRuntimeTask(previous) && previous.status === next.status) return;
    this.resolveTerminalWaiters(taskId, next);
    // 终态同时结算"等待后台化"的等待者：一个已结束的任务永远不会再被后台化，
    // 让它们挂在那里耗尽会话寿命是泄漏。
    this.resolveBackgroundWaiters(taskId, undefined);
  }

  private resolveIfBackgrounded(
    taskId: string,
    next: RuntimeTaskSnapshot,
    previous: RuntimeTaskSnapshot,
  ): void {
    if (next.isBackgrounded !== true) return;
    if (previous.isBackgrounded === true) return;
    this.resolveBackgroundWaiters(taskId, next);
  }

  private resolveTerminalWaiters(taskId: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, taskId, task);
  }

  private resolveBackgroundWaiters(taskId: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.backgroundWaiters, taskId, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    taskId: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(taskId);
    if (!waiters) return;
    waitersByTask.delete(taskId);
    for (const waiter of waiters) {
      // 结算即摘监听器。漏摘会随会话长度线性累积（每个 waiter 一个 listener）。
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(task ? { ...task } : undefined);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    taskId: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(taskId);
    if (!waiters) return;
    waiters.delete(waiter);
    // 空集合要删 key，否则旧任务 id 会永久占位。
    if (waiters.size === 0) waitersByTask.delete(taskId);
  }
}

/** 供测试与诊断：某任务上仍在等待终态的观察者数量。 */
export function terminalWaiterCount(registry: InMemoryRuntimeTaskRegistry, taskId: string): number {
  const waiters = (registry as unknown as { terminalWaiters: Map<string, Set<unknown>> }).terminalWaiters;
  return waiters.get(taskId)?.size ?? 0;
}

/** 供测试与诊断：某任务上仍在等待后台化的观察者数量。 */
export function backgroundWaiterCount(registry: InMemoryRuntimeTaskRegistry, taskId: string): number {
  const waiters = (registry as unknown as { backgroundWaiters: Map<string, Set<unknown>> }).backgroundWaiters;
  return waiters.get(taskId)?.size ?? 0;
}

/** 状态是否已是终态的可读判定（把内部闭集判定外显给消费方，避免各写各的字符串表）。 */
export function isRuntimeTaskSettled(status: string): boolean {
  return isTerminalRuntimeTaskStatus(status);
}
