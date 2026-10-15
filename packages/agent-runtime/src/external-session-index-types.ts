// 一个文件=一种作用：外部会话反向索引的契约、稳定身份计算与越界校验（纯逻辑，不碰 IO）。
//
// 设计借鉴（非源码移植）：把「外部 CLI 自己写到磁盘上的会话文件」增量同步进应用自身库的
// 适配器契约（discover / read 两段式）与「先写库后索引」的竞态处理思路，借鉴自一个
// AGPL-3.0-or-later 的第三方项目（项目名与许可见 THIRD-PARTY-NOTICES.md「语义借用（非源码移植）」
// 小节）。该许可与本仓库（MIT）不兼容，故本文件为 b07 独立实现，未复制任何上游代码。
//
// b07 形态：
//   - 契约两段式：`discover()` 只扫目录列候选（不读内容），`read()` 读单文件并归一化为 b07 形状。
//   - 稳定身份分两层：会话主键（文件级）保证「同一会话一条记录」；内容身份（含摘要）保证幂等。
//   - 所有外部输入（路径、文件形态、会话字段）都做校验，越界/损坏/超大一律 fail closed。

import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 归一化后的消息角色；未知角色视为不支持的来源形态。 */
export type ExternalSessionMessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** 归一化后的单条消息（只保留 b07 需要的字段，不透传外部原始结构）。 */
export interface NormalizedExternalSessionMessage {
  role: ExternalSessionMessageRole;
  text: string;
  /** 消息时间戳（epoch ms），来源未提供则缺席。 */
  at?: number;
}

/** 归一化后的会话形状：b07 自己的会话视图，与任何外部 provider 的原生形状解耦。 */
export interface NormalizedExternalSession {
  /** 外部来源声明的会话标识（已做安全校验）。 */
  externalSessionId: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: readonly NormalizedExternalSessionMessage[];
}

/** 单个文件的读取结果：原始内容摘要 + 归一化会话。 */
export interface ExternalSessionReadResult {
  /** 原始文件内容的 SHA-256（hex），由适配器在读取时计算，是内容身份的一半。 */
  contentDigest: string;
  session: NormalizedExternalSession;
}

/** 发现阶段的候选会话文件（只含元数据，不含内容）。 */
export interface ExternalSessionCandidate {
  /** 绝对路径。 */
  filePath: string;
  /** 相对来源根目录、以 `/` 归一化的路径；稳定身份的一部分。 */
  relativePath: string;
  sizeBytes: number;
  /** 文件修改时间（epoch ms，可含小数）。 */
  modifiedAtMs: number;
}

/**
 * 外部会话来源适配器契约（可注入）。
 * 生产实现扫描真实目录；测试可注入假实现，完全不出网、不碰真实用户目录。
 */
export interface ExternalSessionSourceAdapter {
  /** 来源标识，参与稳定身份计算；同一来源必须稳定不变。 */
  readonly id: string;
  /** 来源根目录；`read()` 必须拒绝任何逃出此目录的路径。 */
  readonly rootDir: string;
  /**
   * 扫描根目录，列出候选会话文件。
   * @param sinceMs 可选水位（epoch ms）；实现应只返回 `modifiedAtMs >= sinceMs` 的候选以支持增量续跑。
   */
  discover(sinceMs?: number): Promise<readonly ExternalSessionCandidate[]>;
  /** 读取单个文件并归一化；损坏/超大/未知/越界时抛 ExternalSessionIndexError（fail closed）。 */
  read(filePath: string): Promise<ExternalSessionReadResult>;
}

/** 索引记录状态：`indexing` 是占位（竞态守卫），`indexed` 是完整记录。 */
export type ExternalSessionIndexStatus = 'indexing' | 'indexed';

/** 索引账本中的一条会话记录。 */
export interface ExternalSessionIndexRecord {
  /** 会话主键（文件级稳定身份）；账本唯一约束 → 保证「同一会话只有一条记录」。 */
  sessionId: string;
  /** 稳定身份（来源 id + 归一化路径 + 内容摘要）；账本唯一约束 → 保证同一内容幂等。 */
  sessionKey: string;
  sourceId: string;
  relativePath: string;
  filePath: string;
  status: ExternalSessionIndexStatus;
  /** 内容摘要；占位记录缺席。 */
  contentDigest?: string;
  externalSessionId?: string;
  title?: string;
  messageCount: number;
  observedSizeBytes: number;
  observedModifiedAtMs: number;
  indexedAtMs: number;
  /** 归一化会话；占位记录缺席。 */
  session?: NormalizedExternalSession;
}

/** 占位登记请求：索引器在读内容之前先写库，避免其他发现者把同一文件当成新会话。 */
export interface ExternalSessionClaim {
  sessionId: string;
  sourceId: string;
  relativePath: string;
  filePath: string;
  observedSizeBytes: number;
  observedModifiedAtMs: number;
  at: number;
}

/** 增量游标/水位：记录某来源上一轮扫描到的最大修改时间与处理条数。 */
export interface ExternalSessionIndexCursor {
  sourceId: string;
  /** 水位（epoch ms）：上一轮扫描到的最大 modifiedAtMs；下一轮以它为 since 续跑。 */
  watermarkMs: number;
  /** 上一轮处理的条目数（写入 + 跳过）。 */
  lastProcessedCount: number;
  updatedAtMs: number;
}

/** 索引账本契约（内存与 SQLite 两实现）。 */
export interface ExternalSessionIndexStore {
  /**
   * 占位登记（幂等）：以会话主键写入占位行；已存在则不覆盖。
   * @returns true 表示本次新建占位（调用方失败时可安全回滚）；false 表示该会话已被登记。
   */
  claim(claim: ExternalSessionClaim): boolean;
  load(sessionId: string): ExternalSessionIndexRecord | undefined;
  /** 以完整记录原子覆盖同主键记录（upsert）→ 同一会话永远只有一条。 */
  commit(record: ExternalSessionIndexRecord): void;
  /** 回滚占位：仅当该行仍是与本次观测匹配的占位时才删除，绝不误删已提交记录。 */
  rollback(sessionId: string, observed: { sizeBytes: number; modifiedAtMs: number }): void;
  list(): readonly ExternalSessionIndexRecord[];
  loadCursor(sourceId: string): ExternalSessionIndexCursor | undefined;
  saveCursor(cursor: ExternalSessionIndexCursor): void;
}

/** 外部会话诊断码（稳定，便于外显与断言）。 */
export type ExternalSessionDiagnosticCode =
  | 'external_session_file_unreadable'
  | 'external_session_file_too_large'
  | 'external_session_file_corrupt'
  | 'external_session_source_unsupported'
  | 'external_session_path_escaped';

export interface ExternalSessionDiagnostic {
  code: ExternalSessionDiagnosticCode;
  message: string;
  path?: string;
  severity: 'error';
}

/** 领域错误：携带稳定诊断码；索引器据此产出可读诊断并 fail closed。 */
export class ExternalSessionIndexError extends Error {
  constructor(
    readonly code: ExternalSessionDiagnosticCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'ExternalSessionIndexError';
  }
}

/** 把任意错误归一为诊断；未知错误按「来源形态不支持」处理，绝不吞掉。 */
export function toExternalSessionDiagnostic(error: unknown, path?: string): ExternalSessionDiagnostic {
  if (error instanceof ExternalSessionIndexError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.path ?? path ? { path: error.path ?? path } : {}),
      severity: 'error',
    };
  }
  return {
    code: 'external_session_source_unsupported',
    message: error instanceof Error ? error.message : String(error),
    ...(path ? { path } : {}),
    severity: 'error',
  };
}

/** 默认会话文件后缀：JSON Lines 形态。 */
export const EXTERNAL_SESSION_FILE_EXTENSION = '.jsonl';
/** 单文件大小上限（8 MiB）；超过即 fail closed，绝不半索引。 */
export const MAX_EXTERNAL_SESSION_FILE_BYTES = 8 * 1024 * 1024;
/** 单文件消息条数上限；超过即 fail closed。 */
export const MAX_EXTERNAL_SESSION_MESSAGES = 100_000;
/** 外部会话标识长度上限。 */
export const MAX_EXTERNAL_SESSION_ID_LENGTH = 256;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 会话主键（文件级稳定身份）= sha256(`es` \0 来源 id \0 归一化路径)。
 * 不含内容摘要，故同一文件内容变化时仍是同一主键 → 更新是覆盖而非新增，
 * 保证「同一会话只有一条记录」。
 */
export function externalSessionIdentity(sourceId: string, relativePath: string): string {
  return `es-${sha256Hex(`es\u0000${sourceId}\u0000${relativePath}`)}`;
}

/**
 * 稳定身份（内容级）= sha256(`ek` \0 来源 id \0 归一化路径 \0 内容摘要)。
 * 含内容摘要，故同一文件重复索引同一内容得到同一身份 → 幂等，不产生重复记录。
 */
export function externalSessionContentIdentity(sourceId: string, relativePath: string, contentDigest: string): string {
  return `ek-${sha256Hex(`ek\u0000${sourceId}\u0000${relativePath}\u0000${contentDigest}`)}`;
}

/**
 * 把 `filePath` 归一为相对 `rootDir` 的 POSIX 路径。
 * 逃出根目录（含 `..` 解析后越界、绝对化后越界）返回 undefined，由调用方 fail closed。
 */
export function normalizeRelativePath(rootDir: string, filePath: string): string | undefined {
  const resolvedRoot = resolve(rootDir);
  const resolvedFile = resolve(filePath);
  const rel = relative(resolvedRoot, resolvedFile);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * 越界校验：断言 `filePath` 落在 `rootDir` 之内，返回归一化相对路径。
 * 越界即抛 `external_session_path_escaped`（与插件市场 `plugin_marketplace_entry_escaped` 同姿态）。
 */
export function assertWithinRoot(rootDir: string, filePath: string): string {
  const rel = normalizeRelativePath(rootDir, filePath);
  if (rel === undefined) {
    throw new ExternalSessionIndexError(
      'external_session_path_escaped',
      `会话文件路径越出来源根目录：${filePath}`,
      filePath,
    );
  }
  return rel;
}
