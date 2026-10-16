// 记忆 recall —— 契约与闭集。
//
// 本文件只放类型、闭集与常量，不含逻辑（与 hook-contract / memory-ledger 的分层一致）：
// 「什么算一条可召回的记忆」是契约，「怎么选、怎么读」在 memory-recall.ts。
//
// 与既有的 MemoryLedger 的分工：MemoryLedger 管的是**账本内的记录**（candidate →
// confirmed 的受审查长期记忆，存在 SQLite 里）；本层管的是**工作区里的事实文件**
// （`.md` 文件，人可直接编辑）。两者最终都汇到 ContextAssembler 的 L2，但来源与
// 信任姿态不同：账本记录必须先确认，事实文件是人写的、默认可信但会陈旧。

/**
 * 记忆文件的类型标注。闭集与上游 ZCode 的 `MEMORY_RECALL_TYPES` 一一对应，
 * 但**不沿用其命名风格**（本仓库用 snake_case，与 memory-ledger 的 `MemoryKind` 一致）。
 *
 * - `user`：关于主人本人的稳定事实（称呼、语言偏好、工作习惯）。
 * - `feedback`：主人对 AI 行为的纠正与要求（"别再用 emoji"、"先跑测试再提交"）。
 * - `project`：项目层面的背景（技术栈、约定、目录职责）。
 * - `reference`：外部事实与出处（文档链接、API 行为、上游源码路径）。
 */
export const MEMORY_RECALL_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export type MemoryRecallType = (typeof MEMORY_RECALL_TYPES)[number];

export function isMemoryRecallType(value: unknown): value is MemoryRecallType {
  return typeof value === 'string' && (MEMORY_RECALL_TYPES as readonly string[]).includes(value);
}

/** 记忆文件清单中的一条。`filePath` 为绝对路径，`filename` 为相对根目录的展示名。 */
export interface MemoryManifestEntry {
  /** 绝对路径，用于读取与去重（去重按路径而非文件名，因为不同子目录可同名）。 */
  readonly filePath: string;
  /** 相对记忆根目录的 POSIX 风格路径，用于展示与模型选择。 */
  readonly filename: string;
  /** 文件修改时间（毫秒）。参与排序与陈旧判定。 */
  readonly mtimeMs: number;
  /** frontmatter 的 `description`，供选择器判断相关性。 */
  readonly description?: string;
  /** frontmatter 的类型标注；缺省表示未标注，不猜测。 */
  readonly type?: MemoryRecallType;
}

/** 一条被读入上下文的记忆（内容已按预算裁切）。 */
export interface RecalledMemory {
  readonly filePath: string;
  readonly filename: string;
  readonly mtimeMs: number;
  /** 已按字节/行上限裁切的正文。 */
  readonly content: string;
  /** 供注入上下文使用的标题行，含陈旧提示（若有）。 */
  readonly header: string;
  /** 因字节上限被裁切到的行数；未裁切时为 `undefined`。 */
  readonly truncatedLineCount?: number;
  /** 完整文件字节数（裁切前），供诊断显示「省了多少」。 */
  readonly sizeBytes: number;
  /** 是否为陈旧记忆（mtime 早于阈值）。 */
  readonly stale: boolean;
}

/** 记忆目录扫描的上限与读取预算。全部可注入，便于测试与上层调参。 */
export interface MemoryRecallLimits {
  /** manifest 最多收录的文件数（按 mtime 倒序取前 N）。 */
  readonly manifestFileLimit: number;
  /** 解析 frontmatter 时最多读取的行数（避免为了看头部而读整个大文件）。 */
  readonly frontmatterLineLimit: number;
  /** 单条记忆正文的行数上限。 */
  readonly contentLineLimit: number;
  /** 单条记忆正文的字节上限（按完整行裁切，不切断多字节字符）。 */
  readonly contentByteLimit: number;
  /** 判定「陈旧」的天数阈值。 */
  readonly staleDayThreshold: number;
}

export const DEFAULT_MEMORY_RECALL_LIMITS: MemoryRecallLimits = Object.freeze({
  manifestFileLimit: 200,
  frontmatterLineLimit: 30,
  contentLineLimit: 200,
  contentByteLimit: 4096,
  staleDayThreshold: 1,
});

/**
 * 文件系统端口。刻意只暴露本层需要的三个只读动作，而不是给一个宽泛的 fs 句柄——
 * 这样工作台（浏览器上下文）也能提供一个只读、无 Node 依赖的实现。
 *
 * 所有方法在失败时应抛出；单个文件失败不得中断整批（调用方逐项收敛）。
 */
export interface MemoryFileSystemPort {
  /** 列出目录下的直接子项。目录需要递归。 */
  listDirectory(path: string): readonly MemoryDirectoryEntry[];
  /** 只取元数据（mtime/大小），**不读内容**——生成清单时用，避免为列个表把每个文件都读一遍。 */
  stat(path: string): MemoryStat;
  /** 读取文件头部若干行，用于解析 frontmatter。 */
  readHead(path: string, limitLines: number): MemoryHead;
  /** 读取整个文件；由调用方负责大小上限。 */
  readWhole(path: string): MemoryFileContent;
}

export interface MemoryStat {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  /** 是否为普通文件（非目录、非链接）。端口实现负责用 lstat 判定、不跟随链接。 */
  readonly isFile: boolean;
}

export interface MemoryDirectoryEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface MemoryHead {
  readonly content: string;
  /** 文件总行数（不只是读到的部分）。 */
  readonly totalLines: number;
}

export interface MemoryFileContent {
  readonly content: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** manifest 扫描结果。`storeStatus` 与 hook-trust-store 同款：损坏必须可区分于「没有」。 */
export type MemoryRecallStatus = 'ok' | 'missing';

export interface MemoryManifestScan {
  readonly status: MemoryRecallStatus;
  readonly entries: readonly MemoryManifestEntry[];
}

/**
 * 可注入的相关性选择器接缝。
 *
 * **为什么是接缝而不是实现**：上游 ZCode 用一次辅助模型调用来选记忆（把 manifest 喂给模型、
 * 让模型返回文件名）。但 b07 的 `agent-runtime` **不调用模型**（见 context-assembly 的类注释，
 * 且 architecture-policy 规定本包只依赖 protocol / capability-placeholder，没有模型端口）。
 * 因此本层只定义接缝：默认实现是**确定性打分**（词面匹配 + 类型权重），
 * 调用方若要模型驱动，注入自己的实现即可——agent-runtime 自身永不发模型请求。
 */
export interface MemoryRecallSelector {
  select(input: MemoryRecallSelectionInput): readonly string[];
}

export interface MemoryRecallSelectionInput {
  readonly manifest: readonly MemoryManifestEntry[];
  readonly query: string;
  /** 已经召回过的文件绝对路径，不得重复召回。 */
  readonly recalledPaths: ReadonlySet<string>;
  /** 本次最多召回几条。 */
  readonly limit: number;
}

/** 类型权重：与 memory-ledger 的 `kindWeight` 同口径（偏好 > 纠正 > 项目 > 出处）。 */
export const MEMORY_RECALL_TYPE_WEIGHT: Readonly<Record<MemoryRecallType, number>> = Object.freeze({
  user: 5,
  feedback: 4,
  project: 3,
  reference: 2,
});

/** 未标注类型的权重：低于任何已标注类型，但不为 0（未标注不等于无关）。 */
export const UNTYPED_MEMORY_WEIGHT = 1;
