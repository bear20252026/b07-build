// 工作区文件回退 —— 契约与闭集。
//
// 本文件只放类型、闭集与常量，不含逻辑（与 workspace-file-contract.ts 的分层一致）：
// 「什么算一次可回退的文件变更」「什么算不安全」是契约，「怎么规划」在 workspace-file-rewind.ts。
//
// ## 为什么这一层在 workbench 而不在 agent-runtime
//
// 它服务的对象是**本目录**的三件东西：`use-direct-conversations.ts` 的对话检查点、
// 本目录的 `workspace-tools.ts` 写入路径、以及同目录的变更日志。agent-runtime 侧的
// `run-workspace-ledger.ts` 是**只读 metadata 账本**，其不变量明写「不能创建文件、读取文件」，
// 文件回退**不能**建在它上面。
//
// 另一条硬约束是架构策略：`architecture-policy.yaml` 里 workbench 的
// `requires` 是 `[protocol, provider-sdk-browser, capability-placeholder]`，
// **不含 agent-runtime**。为了一个纯函数助手去放宽一个 managed 模块的依赖面，
// 等于把一次架构决策夹带进一个功能批次；而 tsconfig 未覆盖 `apps/*/test` 是
// 已知的存量缺陷（有独立修复计划），两者权衡后选择不动边界。
//
// 与既有各层的分工：
// - `workspace-tools.ts`：**写入**侧。每次受控写入都走内容级 CAS
//   （`previousSha256` / `nextSha256`），原生校验磁盘摘要后才落盘。
// - `use-direct-conversations.ts`：对话级检查点，只存**对话快照**。
// - 本层：补上缺的那一格 —— 检查点对应的**文件状态**，以及把工作区带回那一刻的**规划**。
//
// 设计依据见 `docs/design/workspace-file-rewind-cas-design.md`。核心结论一句话：
// 回退本身就是一次 CAS 写入，其 CAS 期望值取自检查点记录的 **after** 状态
// （"系统已知的最后落盘状态"），而非"规划时刚读到的内容"。

/**
 * 一次受控写入留下的文件变更记录。
 *
 * 在写入**成功之后**捕获，因此 `afterContent` 就是磁盘上的真实内容 ——
 * 这条不变式（写入经 CAS ⇒ 落盘内容等于 nextSha256）是回退安全的前提。
 *
 * 记录会经 localStorage 持久化，属于**不可信输入**：读取方必须逐字段校验，
 * 不得假定形状正确。
 */
export interface WorkspaceFileChangeRecord {
  /** 工作区相对路径，与 `workspace-tools.ts` 的 path 口径一致（不解析为绝对路径）。 */
  readonly path: string;
  /** 触发这次写入的工具名。用于识别 shell 类工具（其改动不经 CAS，不可回退）。 */
  readonly toolName: string;
  /** 写入前的内容；`null` 表示写入前文件不存在。回退时据此决定 restore 还是 delete。 */
  readonly beforeContent: string | null;
  /**
   * 写入后的内容；`null` 表示写入把文件删掉了。
   *
   * 两侧都可为 `null` 才能覆盖三种写入：新建（null → 内容）、更新（内容 → 内容）、
   * 删除（内容 → null）。回退时它是 CAS 的**期望当前值** —— 删除记录的期望值
   * 就是"磁盘上应当没有这个文件"（由 `MISSING_CONTENT_SHA256` 哨兵表达）。
   */
  readonly afterContent: string | null;
  /** 写入完成时间（毫秒）。 */
  readonly at: number;
}

/**
 * 回退不安全的原因闭集。
 *
 * 对外词汇表要统一，因此四种原因定义在同一处。其中 `checkpoint_unreadable`
 * **不由规划器产出**（规划器只认识记录与当前文件状态，不认识检查点存储）——
 * 它由调用方在检查点/日志不可读时补入报告，以避免"同一类故障在不同层有不同的名字"。
 */
export const FILE_REWIND_UNSAFE_REASONS = [
  /** 磁盘当前哈希 ≠ 检查点记录的 after ⇒ 该文件在检查点之后被改动过。 */
  'external_modified',
  /** 当前状态读不到（IO 失败）。读不到就不能判定，fail-closed。 */
  'file_read_failed',
  /** 记录本身非法或缺少可用的 after 内容。记录来自持久化存储，必须校验。 */
  'unsupported_record',
  /** 检查点 / 变更日志本身不可读。由调用方补入，不由规划器产出。 */
  'checkpoint_unreadable',
  /**
   * 待回退文件数超过单批上限（原生 `MAX_BATCH_OPERATIONS = 32`，且同批不允许重复路径）。
   *
   * 出现这种情况时**不截断**：截断等于只回退一部分，而部分回退会让工作区进入一个
   * 从未存在过的中间状态（见设计文档 §3.2）。故整次拒绝并如实报告条数。
   */
  'too_many_operations',
] as const;

export type FileRewindUnsafeReason = (typeof FILE_REWIND_UNSAFE_REASONS)[number];

export function isFileRewindUnsafeReason(value: unknown): value is FileRewindUnsafeReason {
  return typeof value === 'string' && (FILE_REWIND_UNSAFE_REASONS as readonly string[]).includes(value);
}

/**
 * 被忽略的文件的原因闭集。
 *
 * 目前只有一种：shell 类工具的改动无法追踪（见 `isShellToolName`）。
 * 保留为闭集而非布尔，是因为将来若有第二种"无法追踪"的来源（如外部程序），
 * 报告里必须能区分，而不是笼统地都叫"忽略了"。
 */
export const FILE_REWIND_IGNORED_REASONS = ['shell_ignored'] as const;

export type FileRewindIgnoredReason = (typeof FILE_REWIND_IGNORED_REASONS)[number];

/** 内容缺失时使用的哨兵哈希。与 ZCode 同名同义，便于两边对账时不必换算。 */
export const MISSING_CONTENT_SHA256 = 'missing';

/**
 * 一条待执行的回退操作。
 *
 * 字段与原生 `workspace_patch` 的 `PatchOperation` **一一对应**，调用方不做二次翻译：
 * - `action: 'delete'` → `{kind:'delete', previous_sha256}`
 * - `action: 'restore'` → `{kind:'update', previous_sha256, next_content, next_sha256}`
 *
 * 这样回退直接映射成一次 patch 批次，自动继承原生 CAS、原生回滚与审批门。
 */
export interface FileRewindOperation {
  /** 工作区相对路径。 */
  readonly path: string;
  /** `restore` = 写回 before 内容；`delete` = 该文件在检查点时还不存在，需删除。 */
  readonly action: 'restore' | 'delete';
  /** CAS 守卫：执行前磁盘必须等于这个摘要（检查点记录的 after）。 */
  readonly previousSha256: string;
  /** 要写入的内容；`delete` 时为 `null`。 */
  readonly nextContent: string | null;
  /** 要写入内容的摘要；`delete` 时为 `null`。 */
  readonly nextSha256: string | null;
  /** 涉及这条路径的工具名（同一路径可能被多次写入），已排序。 */
  readonly toolNames: readonly string[];
}

/** 一个可安全回退的文件（聚合了该路径上的全部操作）。 */
export interface FileRewindSafeFile {
  readonly path: string;
  readonly action: 'restore' | 'delete';
  /** 该路径上被追踪到的写入次数。 */
  readonly operationCount: number;
  readonly toolNames: readonly string[];
}

/** 一个不安全（会阻断整次回退）的文件。 */
export interface FileRewindUnsafeFile {
  readonly path: string;
  readonly reason: FileRewindUnsafeReason;
  readonly operationCount: number;
  readonly toolNames: readonly string[];
  /** 原因码之外的可读补充；不保证存在。 */
  readonly message?: string;
  /** `external_modified` 时：磁盘上的实际摘要。 */
  readonly currentSha256?: string;
  /** `external_modified` 时：检查点记录的期望摘要。 */
  readonly expectedSha256?: string;
}

/** 一个被忽略（不还原、但如实报告）的文件。 */
export interface FileRewindIgnoredFile {
  readonly path: string;
  readonly reason: FileRewindIgnoredReason;
  readonly operationCount: number;
  readonly toolNames: readonly string[];
}

/**
 * 回退计划。**可审计的结构体而非布尔** —— 回退是破坏性动作，
 * 事后要能回答"当时打算动哪些文件、哪些被拦下、为什么"。
 */
export interface FileRewindPlan {
  /** 是否可执行。任一文件不安全即为 `false`（整次阻断，不做部分回退）。 */
  readonly canApply: boolean;
  readonly safeFiles: readonly FileRewindSafeFile[];
  readonly unsafeFiles: readonly FileRewindUnsafeFile[];
  readonly ignoredFiles: readonly FileRewindIgnoredFile[];
  /** 待执行操作；`canApply` 为 `false` 时**必为空数组**。 */
  readonly operations: readonly FileRewindOperation[];
}

/** 读取某个路径当前状态的端口。实现方负责把 IO 错误转成 `failed`，不抛异常。 */
export interface CurrentFileStateReader {
  read(path: string): Promise<{ readonly exists: boolean; readonly content: string | null } | { readonly failed: string }>;
}

/** 内容摘要端口。注入而非直接调 crypto：本包要保持可纯数据单测、无平台依赖。 */
export interface ContentHasher {
  sha256(content: string | null): Promise<string> | string;
}

/** 单个文件的变更记录上限（按会话）。超出后丢弃最旧的记录。 */
export const MAX_FILE_CHANGE_RECORDS = 512;

/** 单条记录允许保存的最大内容长度（字符）。超过则截断为不可回退记录。 */
export const MAX_RECORDED_CONTENT_CHARS = 256 * 1024;

/**
 * 单次回退允许的操作数上限。
 *
 * 与原生 `crates/../workspace_patch.rs` 的 `MAX_BATCH_OPERATIONS` 保持一致（32）：
 * 回退会映射成**一个** patch 批次，超过上限批次会被原生拒绝。两边若漂移，
 * 表现为"规划说可以、提交说不行"的困惑，故在此显式对齐并由测试钉住。
 *
 * 注意上限是对**路径数**而非记录数：同一路径的多次写入会折叠成一条操作
 * （原生批次不允许重复路径）。
 */
export const MAX_REWIND_OPERATIONS = 32;

/**
 * 判断一个工具名是否属于「改动不经 CAS 写入路径」的 shell 类工具。
 *
 * 这类工具的改动系统无从追踪（它可能改了任意文件、内容也不经过我们），
 * 因此既不能回退、也不该阻断回退 —— 归入 ignored 并如实报告。
 *
 * 判据与 ZCode 一致：归一化后是 `bash`/`shell`、含 `terminal`、或以 `shell` 结尾。
 */
export function isShellToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'bash' ||
    normalized === 'shell' ||
    normalized.includes('terminal') ||
    normalized.endsWith('shell')
  );
}

/**
 * 逐字段校验一条文件变更记录。
 *
 * 记录经 localStorage 往返，属于**不可信输入**：JSON.parse 的结果是 `any`，
 * 类型标注在运行时不存在。校验必须落在**规划器真正依赖的字段**上
 * （`path` 非空、`afterContent` 是字符串），而不是"看起来像就放行"。
 *
 * 注意 `beforeContent` 允许为 `null`（表示写入前文件不存在），但**不允许缺失**：
 * 缺失与 `null` 是两件事——前者是记录损坏，后者是"当时没有这个文件"。
 * 把缺失当 `null` 会让一次损坏的记录被解读成"应该删除这个文件"，那是破坏性的。
 *
 * 这条区分**由下面的严格比较承担**：缺失时值为 `undefined`，而
 * `undefined !== null` 为真、`typeof undefined !== 'string'` 也为真，故被拒。
 * 换句话说 `!== null` 必须**严格**——改成 `!= null` 会把 `undefined` 一并放行，
 * 上面那条区分就没了。该性质由 `缺少beforeContent字段与显式null是两件事` 钉住。
 */
export function isWorkspaceFileChangeRecord(value: unknown): value is WorkspaceFileChangeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<WorkspaceFileChangeRecord>;
  if (typeof record.path !== 'string' || !record.path.trim()) return false;
  if (typeof record.toolName !== 'string') return false;
  if (record.afterContent !== null && typeof record.afterContent !== 'string') return false;
  if (record.beforeContent !== null && typeof record.beforeContent !== 'string') return false;
  return true;
}
