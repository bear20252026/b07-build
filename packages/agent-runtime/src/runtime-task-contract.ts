// 一个文件=一种作用：运行期任务注册表契约（任务类型闭集、快照、等待与消息类型）。纯类型，零 IO。
//
// ## 为什么需要这一层
//
// b07 已有两件与"任务"相关的既有能力，但它们回答的是**别的问题**：
// - `RecoverableTaskRuntime`（`recoverable-task-runtime.ts`）回答"一个 DAG 怎么跑完、
//   怎么在崩溃后接着跑"——它是**执行器 + 持久化**，跑的时候是同步 await 的，它没有
//   "任务正在跑，但我现在没在看它"这个概念；
// - `ProviderRuntimeFacet.listBackgroundWork?()/stopBackgroundTask?()`
//   （`provider-sdk/src/config/capability/runtime.ts`）回答"provider 那边还有哪些没完的
//   活"——它是**能力面接缝**，是"问 provider"，不是"我自己的任务台账"。
//
// 本模块补的是中间缺的那一格：**一个不依赖模型、不依赖 provider 的本地任务台账**。
// 它要回答四个恰好是既有两件都答不了的问题：
// 1. 「这个任务什么时候结束？」——需要有**独立观察者**能 await 终态，而不是必须由
//    发起 turn 自己 await（发起 turn 可能已经结束或被用户切走了）。
// 2. 「它在跑吗，还是已经沉到后台了？」——运行中的任务可以被**就地后台化**，让发起
//    方先去做别的。
// 3. 「我能不能往它里面塞一句话？」——父代理/协调者需要给跑着的任务投递追加指令，
//    并且要有明确的"取走"语义，不能重复消费。
// 4. 「这个迟到的完成是谁的？」——会话可以切换分支/重臂，旧代际的迟到完成**绝不能**
//    被当成新代际的结果。
//
// ## 设计来源与许可
//
// 设计研读自 ZCode v3.15.1（Apache-2.0）的
// `apps/zcode-cli/packages/core/src/runtime-task/`（`registry.ts` 296 行、
// `notification.ts` 417 行、`notification-policy.ts` 18 行）与
// `apps/zcode-cli/packages/core/src/tool/executor/background-task-registry.ts`。
// 上游为 Apache-2.0，与本仓库（MIT）兼容，但本模块**未复制其任何代码**——不复制文件、
// 不逐行翻译、不沿用其命名，只研读其设计约束并按 b07 形态独立重写。
// 详见 `THIRD-PARTY-NOTICES.md`。
//
// ## 从上游学到的四条设计约束
//
// 1. **终态是一个闭集，而且"停"要分得清是谁停的**：上游列了六个终态
//    （`completed/failed/cancelled/killed/stopped/lost`）。这个闭集不是为了分类好看——
//    它决定了"用户主动停的"与"模型自己停的"必须能区分，因为前者不该被自动续跑。
//    b07 沿用闭集，并把它外显为可判定的谓词而不是到处写字符串比较。
// 2. **等待要能被取消，且取消后不能泄漏**：上游的 `waitForTerminal(id, { signal })`
//    在 `signal.aborted` 时立刻 reject，并且在 `resolve` 时从监听器上摘掉自己。
//    这不是细节——一个长命会话会反复等待几十个任务，漏摘监听器会线性累积。
//    b07 沿用，并且把"不泄漏"写成测试钉住的约定，而不是写在注释里。
// 3. **"等待后台化"与"等待终态"是两个不同的等待**：上游刻意分成两个 waiter 集合。
//    理由是它们问的是不同的问题——"我还要不要继续盯着它" vs "它到底结束没有"。
//    前者可能在任务远未结束时就被满足（用户切了个页签），后者只可能被终态满足。
//    合成一个会让"后台化"提前唤醒"等终态"的调用者。
// 4. **任务注册时盖章代际，迟到完成按代际丢弃**：上游在 `register()` 时把当时的
//    active branch generation 盖进快照。这是**在注册点固定归属**，而不是在完成点
//    重新判断——因为在完成点已经无从知道它是谁发起的了。b07 沿用这条，
//    实现见 `runtime-task-registry.ts`。
//
// ## 与上游的差异
//
// - 上游的 `RuntimeTaskSnapshot` 继承 `SubagentTaskSnapshot`，携带 `ModelUsage`、
//   `TraceContext`、`AgentOutput` 等 provider/遥测字段。b07 不引入这些——它们属于
//   上层与 provider 层，塞进台账会让"本地任务台账"这个职责被稀释。b07 只保留
//   **运行期调度真正需要的**字段，其余由调用方在 `metadata` 里自带（不解释、不消费）。
// - 上游的 `messageSink` 是一个携带 `Promise<"queued" | "steered">` 的回调。b07 的
//   台账**不持有回调**：回调是执行上下文的一部分，持有它会让台账变成生命周期容器
//   （进而要管销毁），而队列本身已经足够表达"有消息等着被取走"。取走由调用方
//   `drainMessages()` 决定。

/**
 * 任务类型闭集。
 *
 * **刻意是闭集而不是自由字符串**：类型决定"谁负责取消它"、"它的产物在哪"、
 * "终态通知该说什么"。自由字符串会让每个消费点各写各的比较，一处漏改就是静默的
 * 错误分派。新增类型必须同时补上分派分支——这是编译期强制的。
 *
 * 与上游的取值对照（b07 语义）：
 * - `local_agent`：本地子代理任务（b07 侧对应 `subagent-*` 一族）。
 * - `local_bash`：本地命令任务，长跑命令被后台化后由这里追踪。
 * - `local_tool`：本地单个工具调用任务。**上游没有这一档**——上游把
 *   "工具调用"隐含在 bash/agent 里。b07 拆出来是因为 b07 的工具面是可注册的
 *   （见 `packages/capability-placeholder`），一个自定义长跑工具没有 bash 语义也没有
 *   agent 语义，硬塞进前两档会让终态通知说错话。
 * - `local_task`：本地 DAG 任务。**上游也没有这一档**——上游的 `local_workflow`
 *   是脚本式工作流。b07 的 `RecoverableTaskRuntime` 是 DAG，语义不同，故独立一档。
 * - `monitor_mcp`：MCP 监控类长命任务（订阅/监听），它的终态通常由外部触发。
 */
export const RUNTIME_TASK_TYPES = [
  'local_agent',
  'local_bash',
  'local_tool',
  'local_task',
  'monitor_mcp',
] as const;

export type RuntimeTaskType = (typeof RUNTIME_TASK_TYPES)[number];

/** 运行期任务的运行态。 */
export type RuntimeTaskStatus =
  /** 已入账但尚未开始（排队中）。 */
  | 'created'
  /** 正在跑。 */
  | 'running'
  /** 被门控拦住，等待人工决定；**不是终态**——决定之后会继续。 */
  | 'blocked'
  /** 正常结束。 */
  | 'completed'
  /** 出错结束。 */
  | 'failed'
  /** 被请求方主动取消。 */
  | 'cancelled'
  /** 被宿主强杀（进程没了）。 */
  | 'killed'
  /** 被模型自己停下（如 TaskStop）。 */
  | 'stopped'
  /** 失联——既没有终态也没有进程，无法再判定。 */
  | 'lost';

/**
 * 终态闭集。
 *
 * `blocked` **刻意不在**里面：被门控拦住的任务还活着，人工批准后会继续跑。
 * 把它算作终态会让等待者提前醒来并拿到一个"还没结束"的任务。
 *
 * `created` 同理不在——排队中的任务必然还没结束。
 */
export const TERMINAL_RUNTIME_TASK_STATUSES: readonly RuntimeTaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'killed',
  'stopped',
  'lost',
];

const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_RUNTIME_TASK_STATUSES);

/** 状态是否属于终态闭集。接受任意字符串以便调用方传外部来源的状态。 */
export function isTerminalRuntimeTaskStatus(status: string): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

/** 收窄类型守卫：任务快照是否已到终态。 */
export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, 'status'>): boolean {
  return isTerminalRuntimeTaskStatus(task.status);
}

/** 运行期任务类型守卫。 */
export function isRuntimeTaskType(value: string): value is RuntimeTaskType {
  return (RUNTIME_TASK_TYPES as readonly string[]).includes(value);
}

/**
 * 谁请求停止了这个任务。
 *
 * **必须区分**：`user` 是一个决定，`model` 是一次操作，`host` 是一次故障。
 * 终态通知对三者的措辞与后续动作完全不同——尤其"用户停的不要自动续跑"这条只能靠
 * 这个字段判定，靠状态词（都是 `stopped`/`cancelled`）判不出来。
 */
export type RuntimeTaskStopInitiator = 'user' | 'model' | 'host';

/**
 * 投递给运行中任务的一条消息。
 *
 * 台账**只负责排队与取走**，不解释内容、不负责送达。`id` 的幂等由投递方保证
 * （重复 id 由 `queueRuntimeTaskMessage` 拒绝），这样父代理 turn 重放时不会重复转向。
 */
export interface RuntimeTaskPendingMessage {
  /** 幂等 id。同一 id 重复投递被拒绝。 */
  readonly id: string;
  /** 消息正文。不能为空。 */
  readonly message: string;
  /** 协调者看到的摘要；非空时正文按 `摘要\n\n正文` 拼装。 */
  readonly summary?: string;
  /**
   * 是否属于"元信息"消息（如状态变更提示），不是用户/模型的实际指令。
   *
   * 由调用方标注，台账不推断——"这条是不是指令"是内容语义，不是台账能知道的。
   */
  readonly isMeta?: boolean;
  /** 投递方。用于诊断与区分协调者/用户来源。 */
  readonly origin?: RuntimeTaskMessageOrigin;
  /** 入队时刻（毫秒）。 */
  readonly queuedAt: number;
}

/** 消息投递方。 */
export interface RuntimeTaskMessageOrigin {
  readonly kind: 'coordinator' | 'user' | 'host';
  /** 协调者投递时关联的工具调用 id（可诊断）。 */
  readonly toolCallId?: string;
}

/** 任务用量快照。**只放调度层能观测到的量**，不含 provider 计费字段。 */
export interface RuntimeTaskUsage {
  readonly durationMs?: number;
  readonly toolCallCount?: number;
}

/**
 * 一个运行期任务的快照。
 *
 * 不可变：所有变更走 `update()` 产出新对象。这样等待者拿到的快照不会被"后来的写入"
 * 悄悄改掉——等待者是在某个瞬间被唤醒的，它拿到的必须是**那一刻**的值。
 */
export interface RuntimeTaskSnapshot {
  readonly taskId: string;
  readonly type: RuntimeTaskType;
  readonly status: RuntimeTaskStatus;
  /** 任务标签（人类可读），用于面板与通知。 */
  readonly label?: string;
  /**
   * 任务注册时所属的会话分支代际。
   *
   * 用于**迟到完成围栏**：代际切换后，旧代际任务的完成结果不得被新代际消费。
   * 在 `register()` 时盖章而不是在完成时判定——完成时已无从知道它属于谁。
   */
  readonly branchGeneration?: number;
  /**
   * 是否已后台化。
   *
   * `true` 表示发起方已声明"我不再盯着它了"，它可以继续做别的。
   * **与终态无关**：后台化的任务照样会跑到终态。
   */
  readonly isBackgrounded?: boolean;
  /** 是谁请求停止的；只在被主动停止的任务上在场。 */
  readonly stopInitiator?: RuntimeTaskStopInitiator;
  /** 任务产物摘要文本（终态时写入）。 */
  readonly resultSummary?: string;
  /** 失败原因文本（`failed`/`lost` 时在场）。 */
  readonly errorMessage?: string;
  /** 用量。 */
  readonly usage?: RuntimeTaskUsage;
  /** 创建与最近更新时间（毫秒）。 */
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 调用方自带的不透明元数据。
   *
   * 台账**不读、不解释、不消费**它——需要什么就放什么，台账只保证它跟着快照走。
   * 这是刻意留的逃生阀：与其让台账为了容纳某个上层概念而长字段，不如让上层自带。
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 注册一个任务时的输入。快照的 `createdAt`/`updatedAt` 由台账盖章。 */
export interface RuntimeTaskRegistration {
  readonly taskId: string;
  readonly type: RuntimeTaskType;
  /** 缺省 `created`。允许注册即终态（上游同样允许，用于补记已完成的任务）。 */
  readonly status?: RuntimeTaskStatus;
  readonly label?: string;
  /** 显式指定代际；缺省用台账当前的 active generation。 */
  readonly branchGeneration?: number;
  readonly resultSummary?: string;
  readonly errorMessage?: string;
  readonly usage?: RuntimeTaskUsage;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 等待选项。 */
export interface RuntimeTaskWaitOptions {
  /**
   * 取消等待。已 abort 时**立刻** reject（不注册 waiter）；等待中途 abort 会
   * 摘掉监听器后 reject——不摘会随会话长度线性累积。
   */
  readonly signal?: AbortSignal;
}

/**
 * 快照的可变更字段（`update()` 的补丁）。
 *
 * 刻意**不允许**改 `taskId`/`type`/`branchGeneration`：前两者是身份，改了等于换了
 * 一个任务；`branchGeneration` 是注册时固定的归属，允许改就等于把围栏拆了。
 * 该约束由 `applyRuntimeTaskPatch` 强制执行，不是靠类型擦除绕过去。
 */
export interface RuntimeTaskPatch {
  readonly status?: RuntimeTaskStatus;
  readonly label?: string;
  readonly isBackgrounded?: boolean;
  readonly stopInitiator?: RuntimeTaskStopInitiator;
  readonly resultSummary?: string;
  readonly errorMessage?: string;
  readonly usage?: RuntimeTaskUsage;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 台账查询条件（全部为可选，同时给出时按与关系）。 */
export interface RuntimeTaskQuery {
  readonly type?: RuntimeTaskType;
  readonly status?: RuntimeTaskStatus;
  readonly terminal?: boolean;
  readonly backgrounded?: boolean;
  /** 只看某个代际的任务——围栏消费方用这个过滤掉旧代际。 */
  readonly branchGeneration?: number;
}

/**
 * 运行期任务台账端口。
 *
 * 刻意**不含** `run()` / `cancel()` / `stop()`：台账是**登记与观察**，
 * 真正"怎么把任务停下来"是执行层的事（`RecoverableTaskRuntime`、provider 能力面、
 * 或具体工具实现）。把取消动作塞进台账会让台账持有它不该持有的执行上下文。
 */
export interface RuntimeTaskRegistry {
  /** 全部任务，按 `taskId` 稳定排序（保证面板渲染与测试可复现）。 */
  all(): readonly RuntimeTaskSnapshot[];
  /** 按查询条件过滤，顺序同 `all()`。 */
  query(filter?: RuntimeTaskQuery): readonly RuntimeTaskSnapshot[];
  get(taskId: string): RuntimeTaskSnapshot | undefined;
  /** 注册任务。同 id 重复注册直接拒绝——静默覆盖会丢事件。 */
  register(task: RuntimeTaskRegistration): RuntimeTaskSnapshot;
  /** 就地更新。任务不存在返回 `undefined`。 */
  update(taskId: string, patch: RuntimeTaskPatch): RuntimeTaskSnapshot | undefined;
  /** 移除任务。等待者会被结算为"任务已消失"（`undefined`）。 */
  remove(taskId: string): void;
  /**
   * 把运行中的任务就地后台化。
   *
   * 返回 `false` 的三种情形：任务不存在、已是终态、**已经后台化**。
   * 第三种刻意也返回 `false`：它不是失败，是"这个请求没有产生状态变更"，
   * 返回值表达的是「这次调用改变了什么」而不是「当前是不是后台态」。
   */
  requestBackground(taskId: string): boolean;
  /** 设置当前活跃分支代际。之后 `register()` 的任务默认盖这个值。 */
  setActiveBranchGeneration(generation: number): void;
  /** 当前活跃分支代际。 */
  activeBranchGeneration(): number;
  /**
   * 等待任务进入终态。
   *
   * 立即结算的情形：任务已是终态（返回该死快照）、任务不存在（返回 `undefined`）。
   * 注意**后台化不会**提前结算它——"后台化"与"结束"是两件事。
   */
  waitForTerminal(taskId: string, options?: RuntimeTaskWaitOptions): Promise<RuntimeTaskSnapshot | undefined>;
  /**
   * 等待任务被后台化。
   *
   * 立即结算的情形：任务已后台化（返回该快照）、任务不存在或已终态（返回 `undefined`
   * ——不会再被后台化了）。已终态的任务返回 `undefined` 而不是快照，是为了让调用方
   * 一眼看出"等错东西了"。
   */
  waitForBackgroundRequest(taskId: string, options?: RuntimeTaskWaitOptions): Promise<RuntimeTaskSnapshot | undefined>;
  /**
   * 给任务投递一条消息。任务不存在返回 `undefined`；消息 `id` 重复抛错。
   *
   * 已终态的任务**也接受投递**——上游同样如此。理由是投递与消费是解耦的：
   * 已经拿到产物的调用方可能仍想记一笔"我原本要追加的指令"，由消费方决定忽略。
   * 因此消息 `id` 的幂等集合是**台账级**的，不随任务移除而回收。
   */
  queueMessage(taskId: string, message: Omit<RuntimeTaskPendingMessage, 'queuedAt'> & { queuedAt?: number }): RuntimeTaskSnapshot | undefined;
  /** 取走并清空该任务排队的全部消息（FIFO）。无消息返回空数组。 */
  drainMessages(taskId: string): readonly RuntimeTaskPendingMessage[];
  /** 查看排队消息数（不清空）。 */
  pendingMessageCount(taskId: string): number;
}

/** 台账上是否还有"已后台化且仍在跑"的任务。用于面板显隐与关闭确认。 */
export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return registry
    .all()
    .some((task) => task.isBackgrounded === true && task.status === 'running');
}

/**
 * 代际围栏判定：该任务的完成结果是否归属于给定代际。
 *
 * - 任务不存在 → `false`（无从归属）。
 * - 任务未到终态 → `false`（还没完成，谈不上"迟到完成"）。
 * - 任务没有代际（注册时台账也没有生成）→ **`false`**，fail-closed。
 *   宁可让一个无代际的完成结果不被消费，也不要让它在任何代际下都被消费——
 *   后者在多分支会话里就是结果错投。
 */
export function isRuntimeTaskCompletionInGeneration(
  task: RuntimeTaskSnapshot | undefined,
  generation: number,
): boolean {
  if (task === undefined) return false;
  if (!isTerminalRuntimeTask(task)) return false;
  if (task.branchGeneration === undefined) return false;
  return task.branchGeneration === generation;
}
