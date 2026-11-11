// 动态工作流的 facade —— **模型可写面的唯一事实源**。
//
// ## 这是什么
//
// 主代理（模型）不再只靠一串工具调用干活，而是**写一段 TypeScript 脚本**把多步子任务
// 编排起来：起若干子代理、给它们派活、读工作区、跑命令。这份 `.d.ts` 就是它能写的
// 全部东西 —— 没有别的全局，没有 `require`，没有 `process`。
//
// 为什么用脚本而不是工具链：工具链只能表达"一步接一步"，表达不了"这三件事并行、
// 结果汇到第四步"。而脚本能。代价是**自由度过高**，所以要用 facade 把可写面收窄，
// 再由 `sites.ts` 把脚本里的效应**静态枚举**出来 —— 这样"批准一次运行"才有确切含义。
//
// ## 与 ZCode 的关系（设计研读，未复制其代码）
//
// 形态照搬 ZCode `@zcode/dynamic-workflow` 的 facade：**一个名词（actor）、一个动词（task）**，
// facade 作为嵌入式字符串随包发布（那里叫 `FACADE_DTS`），编译器在虚拟宿主里对着它
// 做类型检查。ZCode 把 facade 拆成段常量再拼接，是为了给 snippet 模式拼出一个子集；
// b07 没有 snippet 模式，所以这里就是**一整段**，但每个声明都写了"为什么有它"。
//
// ## 刻意不移植的部分（连同理由）
//
// - `report` / `artifact.*`：ZCode 用它把中间产物推给用户（图表 / 表格 / 看板）。
//   b07 的产物账本（`assistant_artifact_ledger`）是另一套基底，把 facade 抄过来
//   只会给模型一个**永远 reject** 的 API —— 那比没有更糟。
// - `phase()`：纯展示（无站点、无 journal 行）。没有图渲染器时它什么也不产生。
// - `hole<T>()`：留白由**主代理**在运行中补全，需要交互式主代理回路。
// - `git.*`：b07 还没有把 git 视图暴露给脚本。
// - `channel` / `future`：流水线的流式通道。
//
// 这些不是"做不到"，是"现在做只会给出一个空壳"。少而真优于多而假。

/**
 * facade 的文件名。
 *
 * **必须固定**：站点收集按声明文件名判定"这个名字是不是 facade 提供的"
 * （见 `sites.ts` 的 `isFacadeFile`）。换个名字会让站点收集静默变空 ——
 * 脚本编译通过却什么都不做，而那是本模块最危险的一类失败。
 */
export const WORKFLOW_FACADE_FILE_NAME = 'workflow-facade.d.ts';

/**
 * facade 源码（`.d.ts`）。
 *
 * 这是**唯一事实源**：给模型看的说明、编译器的类型检查、站点收集的判定，都读这一份。
 * 抄成两份就会漂移，而漂移是静默的（两边都能编译过）。
 */
export const WORKFLOW_FACADE_DTS = `
/** 一次 ask 的待定结果。await 它，或把它交给 Promise.all。 */
declare interface Node<T> extends PromiseLike<T> {}

/** 子代理的人设，在 agent() 创建它时固定。所有子代理拥有同样的工作工具。 */
declare interface AgentPersona {
  /** 描述这个 actor 职责的系统提示。 */
  system?: string;
  /** 模型 id 字面量；省略则用本次运行的子代理模型。 */
  model?: string;
}

/**
 * 一个子代理：一条**跨 ask 保持上下文**的对话。它忙的时候派来的 ask 按先来后到排队。
 */
declare interface Agent {
  /**
   * 给这个子代理一个任务。带类型参数时，答案是 T 类型的值；不带时，答案是它的最终回复文本。
   */
  ask<T = string>(instructions: string): Node<T>;
}

/**
 * 创建一个子代理。每次调用都开始一条**全新、空**的对话；要共享就共享返回值。
 * 非空名字是一个身份：本次运行内唯一，且是"续跑时复用哪份已记录工作"的键。
 */
declare function agent(name?: string, persona?: AgentPersona): Agent;

/** 给用户发一条进度消息。 */
declare function log(message: string): void;

/** files.grep 命中的一行。 */
declare interface GrepMatch {
  /** 命中文件的工作区相对路径。 */
  path: string;
  /** 命中行的行号（从 1 开始）。 */
  line: number;
  /** 命中行的完整文本。 */
  text: string;
}

/**
 * 工作区的**只读**视图。每个结果都会被记录，所以续跑的运行拿到的是**同一个答案**，
 * 而不是重新读一遍。没有写：写是子代理的任务。
 */
declare const files: {
  /** 匹配 glob 的工作区相对路径，已排序。 */
  glob(pattern: string): Promise<string[]>;
  /** 读一个工作区文件为 UTF-8 文本。 */
  read(path: string): Promise<string>;
  /** 用 ripgrep 兼容的正则搜内容，可用 glob 收窄路径（"*.ts"、"src/**"）。 */
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};

/** 一次 world.run 的结果，**包含非零退出**。 */
declare interface WorldRunResult {
  /** 进程退出码。非零是正常返回值 —— 分支处理它。 */
  exitCode: number;
  /** 捕获的 stdout（UTF-8）。 */
  stdout: string;
  /** 捕获的 stderr（UTF-8）。 */
  stderr: string;
}

/**
 * 跑一条命令。每次调用只跑一次，结果被记录：续跑的运行**复用记录**而不是重跑。
 * 进程跑完就 resolve（非零退出也算）；只有 spawn 失败或超时才 reject。
 * cmd 必须是编译期字面量（会在确认时展示给用户）。固定 argv，**绝不经过 shell**：
 * 没有管道、重定向或展开。cwd 是工作区。
 */
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult>;
};

/**
 * 本次运行的实参。已保存的工作流会先按它声明的参数校验并填默认值，再开始运行。
 * 值本身是未知的，所以要自己收窄（\`String(args.target)\` 或 typeof 守卫）。
 */
declare const args: Readonly<Record<string, unknown>>;
`;
