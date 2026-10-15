// 一个文件=一种作用：默认外部会话来源适配器（JSON Lines 形态的磁盘会话文件）。
//
// 设计借鉴（非源码移植）：两段式适配器（discover 只列候选 / read 读单文件并归一化）与
// 「先写库后索引」的竞态处理思路，借鉴自一个 AGPL-3.0-or-later 的第三方项目（项目名与许可
// 见 THIRD-PARTY-NOTICES.md「语义借用（非源码移植）」小节）。本文件为 b07 独立实现，未复制任何上游代码。
//
// b07 自定义的会话文件形态（JSON Lines，逐行一个 JSON 对象）：
//   首行必须是会话头：{ "type": "session", "sessionId": "<id>", "title"?: string,
//                       "createdAt"?: number, "updatedAt"?: number }
//   其余行是消息：    { "type": "message", "role": "user|assistant|system|tool",
//                       "text": string, "at"?: number }
//   空行忽略；未知 `type`、缺失会话头、非法 JSON 一律 fail closed。
//
// fail closed：损坏 → external_session_file_corrupt；未知形态 → external_session_source_unsupported；
// 超大 → external_session_file_too_large；读失败 → external_session_file_unreadable；
// 路径越界 → external_session_path_escaped。

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertWithinRoot,
  EXTERNAL_SESSION_FILE_EXTENSION,
  ExternalSessionIndexError,
  MAX_EXTERNAL_SESSION_FILE_BYTES,
  MAX_EXTERNAL_SESSION_ID_LENGTH,
  MAX_EXTERNAL_SESSION_MESSAGES,
  normalizeRelativePath,
  type ExternalSessionCandidate,
  type ExternalSessionMessageRole,
  type ExternalSessionReadResult,
  type ExternalSessionSourceAdapter,
  type NormalizedExternalSession,
  type NormalizedExternalSessionMessage,
} from './external-session-index-types.js';

const ROLES = new Set<ExternalSessionMessageRole>(['user', 'assistant', 'system', 'tool']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalEpoch(value: unknown, label: string, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ExternalSessionIndexError('external_session_file_corrupt', `会话头字段 ${label} 必须是非负有限数`, path);
  }
  return value;
}

function requireSessionId(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new ExternalSessionIndexError('external_session_file_corrupt', '会话头缺少字符串 sessionId', path);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_SESSION_ID_LENGTH || /[\r\n\0]/u.test(trimmed)) {
    throw new ExternalSessionIndexError(
      'external_session_file_corrupt',
      `sessionId 必须是 1-${MAX_EXTERNAL_SESSION_ID_LENGTH} 位且不含控制字符`,
      path,
    );
  }
  return trimmed;
}

/**
 * 解析 JSON Lines 会话文件为 b07 归一化形状。
 * 任一行不合法即整体抛错（绝不返回半解析结果），由调用方按诊断码 fail closed。
 */
export function parseJsonLinesSession(raw: string, options: { path: string; maxMessages?: number }): NormalizedExternalSession {
  const path = options.path;
  const maxMessages = options.maxMessages ?? MAX_EXTERNAL_SESSION_MESSAGES;
  const messages: NormalizedExternalSessionMessage[] = [];
  let header: { externalSessionId: string; title?: string; createdAt?: number; updatedAt?: number } | undefined;

  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) continue;
    const lineNo = index + 1;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new ExternalSessionIndexError('external_session_file_corrupt', `第 ${lineNo} 行不是合法 JSON`, path);
    }
    if (!isRecord(value)) {
      throw new ExternalSessionIndexError('external_session_file_corrupt', `第 ${lineNo} 行必须是 JSON 对象`, path);
    }

    if (value.type === 'session') {
      if (header) throw new ExternalSessionIndexError('external_session_file_corrupt', `第 ${lineNo} 行出现重复会话头`, path);
      const title = value.title;
      if (title !== undefined && (typeof title !== 'string' || title.length > 500)) {
        throw new ExternalSessionIndexError('external_session_file_corrupt', `第 ${lineNo} 行 title 必须是 ≤500 位文本`, path);
      }
      header = {
        externalSessionId: requireSessionId(value.sessionId, path),
        ...(title !== undefined ? { title } : {}),
        ...(optionalEpoch(value.createdAt, 'createdAt', path) !== undefined ? { createdAt: value.createdAt as number } : {}),
        ...(optionalEpoch(value.updatedAt, 'updatedAt', path) !== undefined ? { updatedAt: value.updatedAt as number } : {}),
      };
      continue;
    }

    if (value.type === 'message') {
      if (!header) throw new ExternalSessionIndexError('external_session_file_corrupt', `第 ${lineNo} 行消息出现在会话头之前`, path);
      const role = value.role;
      if (typeof role !== 'string' || !ROLES.has(role as ExternalSessionMessageRole)) {
        throw new ExternalSessionIndexError(
          'external_session_source_unsupported',
          `第 ${lineNo} 行消息角色不受支持：${String(role)}`,
          path,
        );
      }
      if (typeof value.text !== 'string') {
        throw new ExternalSessionIndexError('external_session_file_corrupt', `第 ${lineNo} 行消息缺少字符串 text`, path);
      }
      const at = optionalEpoch(value.at, 'at', path);
      messages.push({ role: role as ExternalSessionMessageRole, text: value.text, ...(at !== undefined ? { at } : {}) });
      if (messages.length > maxMessages) {
        throw new ExternalSessionIndexError(
          'external_session_file_too_large',
          `消息条数超过上限 ${maxMessages}`,
          path,
        );
      }
      continue;
    }

    throw new ExternalSessionIndexError(
      'external_session_source_unsupported',
      `第 ${lineNo} 行记录类型不受支持：${String(value.type)}`,
      path,
    );
  }

  if (!header) throw new ExternalSessionIndexError('external_session_file_corrupt', '缺少会话头记录', path);
  return { ...header, messages };
}

export interface JsonLinesExternalSessionSourceOptions {
  /** 来源标识；参与稳定身份计算。 */
  id: string;
  /** 来源根目录。 */
  rootDir: string;
  /** 单文件大小上限（字节）；默认 8 MiB。 */
  maxBytes?: number;
  /** 单文件消息条数上限；默认 100000。 */
  maxMessages?: number;
}

/**
 * 默认来源适配器：递归扫描根目录下的 `*.jsonl` 会话文件（跳过点目录），
 * 逐行解析为 b07 归一化会话。测试用临时目录即可完全离线。
 */
export class JsonLinesExternalSessionSource implements ExternalSessionSourceAdapter {
  readonly id: string;
  readonly rootDir: string;
  private readonly maxBytes: number;
  private readonly maxMessages: number;

  constructor(options: JsonLinesExternalSessionSourceOptions) {
    this.id = options.id;
    this.rootDir = resolve(options.rootDir);
    this.maxBytes = options.maxBytes ?? MAX_EXTERNAL_SESSION_FILE_BYTES;
    this.maxMessages = options.maxMessages ?? MAX_EXTERNAL_SESSION_MESSAGES;
  }

  async discover(sinceMs?: number): Promise<readonly ExternalSessionCandidate[]> {
    const root = this.rootDir;
    const candidates: ExternalSessionCandidate[] = [];

    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // 不可读目录按「无候选」处理，不影响其余目录；不产出诊断以免噪声。
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(EXTERNAL_SESSION_FILE_EXTENSION)) continue;
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (sinceMs !== undefined && stat.mtimeMs < sinceMs) continue;
        const relativePath = normalizeRelativePath(root, full);
        if (relativePath === undefined) continue;
        candidates.push({ filePath: full, relativePath, sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs });
      }
    };

    walk(root);
    candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return candidates;
  }

  async read(filePath: string): Promise<ExternalSessionReadResult> {
    // 越界校验：不得逃出配置的根目录（与插件市场同一 fail-closed 姿态）。
    const relativePath = assertWithinRoot(this.rootDir, filePath);

    let sizeBytes: number;
    try {
      sizeBytes = statSync(filePath).size;
    } catch {
      throw new ExternalSessionIndexError('external_session_file_unreadable', `会话文件不可读：${relativePath}`, relativePath);
    }
    if (sizeBytes > this.maxBytes) {
      throw new ExternalSessionIndexError(
        'external_session_file_too_large',
        `会话文件超过大小上限 ${this.maxBytes} 字节（实际 ${sizeBytes}）`,
        relativePath,
      );
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      throw new ExternalSessionIndexError('external_session_file_unreadable', `会话文件读取失败：${relativePath}`, relativePath);
    }

    const contentDigest = createHash('sha256').update(raw, 'utf8').digest('hex');
    const session = parseJsonLinesSession(raw, { path: relativePath, maxMessages: this.maxMessages });
    return { contentDigest, session };
  }
}

/** 工厂：与既有适配器同形，便于注入索引器。 */
export function createJsonLinesExternalSessionSource(
  options: JsonLinesExternalSessionSourceOptions,
): ExternalSessionSourceAdapter {
  return new JsonLinesExternalSessionSource(options);
}
