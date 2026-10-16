// 一个文件=一种作用：运行期任务终态通知的格式化与抑制策略。纯函数，零 IO、不调模型。
//
// ## 为什么通知要单独一层
//
// 任务跑到终态之后，**发起方往往已经不在了**——它可能结束了自己那一轮，或者用户切走了
// 会话。所以终态必须变成一条**能被后来者读懂的消息**回到主线，而不是只躺在台账里等被轮询。
//
// 这条消息要回答的恰好是四件事（少一件，读到的人就得自己推理）：
// 1. **是谁的** —— `taskId` / `type`；
// 2. **怎么了** —— `status`，且对"被停"的任务要说清**是谁停的**；
// 3. **结果是什么** —— 产物摘要或失败原因；
// 4. **我该做什么** —— 这是最容易被省略、但最要紧的一件。同样一个 `stopped`，
//    "用户按了停" 与 "模型自己 TaskStop 为了改脚本" 的下一步动作**恰好相反**。
//
// ## 设计来源与许可
//
// 设计研读自 ZCode v3.15.1（Apache-2.0）的
// `apps/zcode-cli/packages/core/src/runtime-task/notification.ts`（417 行）、
// `notification-policy.ts`（18 行）与 `workflow-notification-copy.ts`（243 行）。
// 上游为 Apache-2.0，与本仓库（MIT）兼容，但本模块**未复制其任何代码**——不复制文件、
// 不逐行翻译、不沿用其命名与文案，只研读其设计约束并按 b07 形态独立重写。
// 详见 `THIRD-PARTY-NOTICES.md`。
//
// ## 从上游学到的四条设计约束
//
// 1. **用 XML 标签块而不是自然语言段落**：任务通知会随上下文一起进模型。结构化标签让
//    "哪一段是状态、哪一段是产物"无需模型解析散文就能区分，也让截断可以按节取舍。
//    b07 沿用标签形态，标签名与文案自行拟定。
// 2. **有总长上限，且截断顺序是设计过的**：上游设 120k 字符上限。上限本身不稀奇，
//    稀奇的是**先斩谁**——上游把"产出节"排在结果之后，让总截断先砍产出、再砍指引，
//    结果与状态永远保住。b07 沿用这个顺序，并把取舍理由写在代码里。
// 3. **状态词要说真话**：上游区分"追踪器的通用词"与"run 的真实终态词"，因为通用词会
//    把 `stopped` 折成 `killed`、`errored` 折成 `failed`。b07 不引入两套词汇，改为
//    **一个状态词 + 一个 stopInitiator**：状态说发生了什么，initiator 说是谁做的决定。
//    这样不会出现"两个字段说同一件事但可能不一致"。
// 4. **抑制规则要能判定，不能靠"好像不重要"**：上游的 `notification-policy.ts` 只有
//    18 行，但它是一条**可判定的**规则（子代理 + 密封 + bash 类 → 抑制）。
//    b07 沿用"外显谓词"的做法，见 `shouldSuppressRuntimeTaskNotification`。
//
// ## 与上游的差异
//
// - 上游为 workflow run 准备了 243 行的文案表（三终态 × 五个 stop reason ×
//   scriptPath / artifacts / reports 组合）。那套文案是围绕**脚本式工作流**的
//   Amend/Resume 动作写的，b07 没有这两个动作，照抄会写出指向不存在工具的指引。
//   b07 只保留**动作语义**（"用户停的不要自动续"/"模型为修而停的应当场续"），
//   文案按 b07 的实际动作重写，并在没有对应动作时不提动作。
// - b07 把格式化与抑制拆成同一文件的两个纯函数：它们服务同一个消费点（事件流出口），
//   拆成两个文件会让"这条通知该不该发"与"发了长什么样"分居两处，改动时容易只改一边。

import {
  isTerminalRuntimeTask,
  type RuntimeTaskSnapshot,
  type RuntimeTaskStopInitiator,
} from './runtime-task-contract.js';

/**
 * 终态通知的总字符上限。
 *
 * 取 120k 与上游同量级：这个量级下"一条通知吃掉整个上下文"不可能发生，
 * 而正常规模的产物摘要（几 k）又永远碰不到上限。**上限存在的意义不是省钱，
 * 是保证一条畸形的大产物不会把后续所有轮次挤掉。**
 */
export const RUNTIME_TASK_NOTIFICATION_MAX_CHARS = 120_000;

/** 格式化输入。 */
export interface RuntimeTaskNotificationInput {
  readonly task: RuntimeTaskSnapshot;
  /**
   * 产物节文本。
   *
   * **排在结果之后**：总截断先斩它。理由是"任务收了什么场"是读者首先要读的，
   * 产物是补充材料。
   */
  readonly output?: string;
  /**
   * 是否追加"下一步"指引。
   *
   * 缺省 `true`（终态通知默认带指引）——指引是这份通知里最容易漏、也最贵的一件。
   */
  readonly deliveryGuidance?: boolean;
}

/** XML 文本转义。只转 `<`/`>`/`&`，引号原样——属性值由本模块自己生成，不受输入影响。 */
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 按上限截断，并在截断处**显式标注**。
 *
 * 静默截断是最坏的做法：读到的人以为这就是全部。标注让"这份材料是残缺的"
 * 成为一个可判定的事实。
 */
export function truncateRuntimeTaskNotification(text: string): string {
  if (text.length <= RUNTIME_TASK_NOTIFICATION_MAX_CHARS) return text;
  const marker = '\n[通知因超出长度上限被截断]';
  return `${text.slice(0, RUNTIME_TASK_NOTIFICATION_MAX_CHARS - marker.length)}${marker}`;
}

/**
 * 下一步指引。
 *
 * 动作语义来自上游（见模块头约束 4 的对照），但**文案与动作名按 b07 重写**。
 * 四条分支覆盖四种真实情形：
 *
 * - `completed`：呈现结果，不要复述过程。
 * - `failed`/`lost`：先呈现已完成的部分，再讲失败与下一步。
 * - 任何非 completed 且 `stopInitiator === 'user'`：**用户是按了停的**，
 *   不要自动续跑——这条如果写错，模型会把用户刚停的任务又拉起来。
 * - `stopInitiator === 'model'`：模型自己停的。如果是为了修正而停，应当当场续跑；
 *   否则按普通未完成处理。
 */
export function runtimeTaskDeliveryGuidance(task: RuntimeTaskSnapshot): string {
  const stopInitiator: RuntimeTaskStopInitiator | undefined = task.stopInitiator;

  if (task.status === 'completed') {
    return [
      '这个任务已完成。把它的结果当交付物呈现给用户：先给结论，再给支持结论的证据（路径与行号，或命令与其输出）。',
      '不要复述任务的执行过程或调度结构。',
    ].join('\n');
  }

  if (task.status === 'failed' || task.status === 'lost') {
    return [
      '这个任务没有正常完成。先呈现它在结束前已经完成的部分，再说明失败原因与本可继续的下一步。',
      '不要把它当作已经完成的产出呈现给用户。',
    ].join('\n');
  }

  // 用户主动停的：这是一个**决定**，不是一次意外。
  if (stopInitiator === 'user') {
    return [
      '用户主动停止了这个任务。除非用户明确要求，不要自动恢复它。',
      '呈现它停止前已经完成的部分，然后等用户说明下一步。',
    ].join('\n');
  }

  // 模型自己停的：可能是为了修正之后再跑。
  if (stopInitiator === 'model') {
    return [
      '这个任务是被你自己停止的。如果你是为了修正它才停的，现在就带着修正后的输入重新提交——已经完成的步骤不会白跑。',
      '否则呈现它已完成的部分，并在用户确认后再决定是否继续。',
    ].join('\n');
  }

  // 其余（cancelled/host 导致、或没有 initiator）：不假定任何人可以自动续跑。
  return [
    '这个任务在完成前停止了。呈现它已完成的部分，并在用户确认后再决定是否继续。',
    '不要自动恢复它。',
  ].join('\n');
}

/**
 * 格式化一条终态通知。
 *
 * 节顺序（**这个顺序就是总截断的取舍顺序**）：
 * `task-id` → `task-type` → `status` → `stop-initiator`（可选）→ `label`（可选）
 * → `error`（可选，失败时最该先看到的）→ `result`（可选）→ `output`（可选，最先被斩）
 * → 指引（最后被斩的是核心节，所以指引放在末节之外）。
 */
export function formatRuntimeTaskNotification(input: RuntimeTaskNotificationInput): string {
  const { task } = input;
  const lines = ['<runtime-task-notification>'];
  lines.push(`  <task-id>${escapeXml(task.taskId)}</task-id>`);
  lines.push(`  <task-type>${escapeXml(task.type)}</task-type>`);
  lines.push(`  <status>${escapeXml(task.status)}</status>`);
  if (task.stopInitiator !== undefined) {
    lines.push(`  <stop-initiator>${escapeXml(task.stopInitiator)}</stop-initiator>`);
  }
  if (task.branchGeneration !== undefined) {
    lines.push(`  <branch-generation>${task.branchGeneration}</branch-generation>`);
  }
  if (task.label !== undefined && task.label.trim() !== '') {
    lines.push(`  <label>${escapeXml(task.label)}</label>`);
  }
  if (task.errorMessage !== undefined && task.errorMessage.trim() !== '') {
    lines.push(`  <error>${escapeXml(task.errorMessage)}</error>`);
  }
  if (task.resultSummary !== undefined && task.resultSummary.trim() !== '') {
    lines.push(`  <result>${escapeXml(task.resultSummary)}</result>`);
  }
  if (task.usage !== undefined && (task.usage.durationMs !== undefined || task.usage.toolCallCount !== undefined)) {
    const attributes: string[] = [];
    if (task.usage.durationMs !== undefined) attributes.push(`duration-ms="${task.usage.durationMs}"`);
    if (task.usage.toolCallCount !== undefined) attributes.push(`tool-calls="${task.usage.toolCallCount}"`);
    lines.push(`  <usage ${attributes.join(' ')}/>`);
  }
  if (input.output !== undefined && input.output.trim() !== '') {
    lines.push(`  <output>${escapeXml(input.output)}</output>`);
  }
  lines.push('</runtime-task-notification>');

  const body = lines.join('\n');
  if (input.deliveryGuidance === false) return truncateRuntimeTaskNotification(body);
  // 指引在标签块**之外**：它是给读通知的代理的指令，不是任务数据的一部分。
  // 混进标签里会让"取走数据"的下游把它也当数据存下来。
  return truncateRuntimeTaskNotification([body, '', runtimeTaskDeliveryGuidance(task)].join('\n'));
}

/** 抑制判定的输入。 */
export interface RuntimeTaskNotificationSuppressionInput {
  /** 该通知是否要发给一个"子代理子运行上下文"。 */
  readonly isSubagentChildRuntime: boolean;
  /** 该子运行的通知出口是否已密封（父代理已接手呈现）。 */
  readonly notificationSealed: boolean;
  /** 台账里的任务快照；任务已被移除时为 `undefined`。 */
  readonly task?: Pick<RuntimeTaskSnapshot, 'type'>;
  /** 触发通知的工具名（如 `Bash`）。 */
  readonly toolName?: string;
}

/**
 * 是否抑制这条通知。
 *
 * 三个条件**同时**成立才抑制：① 当前是子代理的子运行；② 该子运行的通知已密封
 * （父代理已在呈现）；③ 这条通知来自 bash 类任务。
 *
 * 为什么三个都要：
 * - 少了 ①：主运行自己的 bash 通知会被误吞，用户看不到命令结果；
 * - 少了 ②：父代理还没接手就把子通知吞了，等于两边都没说；
 * - 少了 ③：会把子代理的**产出类**通知一起吞掉——那些正是父代理要拿去呈现的东西。
 *
 * 判据同时看 `toolName === 'Bash'` 与 `task.type === 'local_bash'`：前者覆盖
 * "任务已被移除、只剩工具名"的情形，后者覆盖"工具名不是 Bash 但语义等价"的实现。
 * 两者是**或**关系，任一命中即算 bash 类——这正是"有意放宽一侧以防漏判"的选择：
 * 漏抑制会让用户看到重复通知（烦），误抑制会让用户看不到通知（错）。
 */
export function shouldSuppressRuntimeTaskNotification(
  input: RuntimeTaskNotificationSuppressionInput,
): boolean {
  if (!input.isSubagentChildRuntime) return false;
  if (!input.notificationSealed) return false;
  if (input.toolName === 'Bash') return true;
  return input.task?.type === 'local_bash';
}

/**
 * 把所有已入终态的任务格式化成一条通知（用于面板刷新/补发）。
 *
 * **按 `taskId` 稳定排序**：面板刷新可能重复调用，顺序不稳定会让"同一批任务的输出
 * 每次都不一样"，从而无法 diff、也无法断言。
 */
export function formatSettledRuntimeTasks(
  tasks: readonly RuntimeTaskSnapshot[],
): string {
  return tasks
    .filter((task) => isTerminalRuntimeTask(task))
    .slice()
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((task) => formatRuntimeTaskNotification({ task }))
    .join('\n');
}
