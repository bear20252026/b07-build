// 一个文件=一种作用：结构化 Patch 的第一期策略——把解析结果筛成「可安全执行的计划」。
//
// 第一期边界（审计结论，故意从窄）：
// - 只允许「更新已存在文件」；add / delete / move 一律拒绝（第二期走 Rust 显式审批接口）；
// - 路径必须是工作区内的相对 POSIX 路径：拒绝绝对路径、盘符、`..` 逃逸、反斜杠外的
//   空段；symlink 由 Rust 文件层拒绝（workspace_files 已不列出不穿越符号链接）；
// - 重复目标拒绝：同一文件被两个 section 更新时顺序语义易错，第一期直接拒绝。
//
// 策略只产出计划，不做 I/O；写入仍走 b07 原生审批 + Rust 路径约束。

import type { PatchChunk, ParsedPatch } from './patch-parser.js';

export interface PatchFileUpdate {
  path: string;
  chunks: PatchChunk[];
}

export interface PatchPlanRejection {
  path: string;
  /** 稳定的拒绝原因码，供审批界面与审计记录使用。 */
  reason: 'phase1-update-only' | 'path-escapes-workspace' | 'file-not-found' | 'duplicate-patch-target';
  detail?: string;
}

export interface SafePatchPlan {
  updates: PatchFileUpdate[];
  rejections: PatchPlanRejection[];
}

export interface PatchPlanOptions {
  /** 当前工作区内「真实存在且非符号链接」的相对路径集合（由 Rust workspace_files 列出）。 */
  existingFiles: ReadonlySet<string>;
}

export function planPatchSections(sections: readonly ParsedPatch[], options: PatchPlanOptions): SafePatchPlan {
  const updates: PatchFileUpdate[] = [];
  const rejections: PatchPlanRejection[] = [];
  const seen = new Set<string>();

  const reject = (path: string, reason: PatchPlanRejection['reason'], detail?: string): void => {
    rejections.push({ path, reason, ...(detail === undefined ? {} : { detail }) });
  };

  for (const section of sections) {
    if (section.type === 'add') {
      reject(section.path, 'phase1-update-only', 'add file');
      continue;
    }
    if (section.type === 'delete') {
      reject(section.path, 'phase1-update-only', 'delete file');
      continue;
    }
    if (section.movePath !== undefined) {
      reject(section.path, 'phase1-update-only', 'move file');
      continue;
    }
    const path = normalizeRelativePath(section.path);
    if (path === undefined) {
      reject(section.path, 'path-escapes-workspace');
      continue;
    }
    if (seen.has(path)) {
      reject(path, 'duplicate-patch-target');
      continue;
    }
    if (!options.existingFiles.has(path)) {
      reject(path, 'file-not-found');
      continue;
    }
    seen.add(path);
    updates.push({ path, chunks: section.chunks });
  }

  return { updates, rejections };
}

/** 归一化为工作区相对 POSIX 路径；不合法（逃逸/绝对/盘符）返回 undefined。 */
export function normalizeRelativePath(path: string): string | undefined {
  const trimmed = path.trim().replaceAll('\\', '/');
  if (trimmed.length === 0 || trimmed.length > 512) return undefined;
  if (trimmed.startsWith('/')) return undefined;
  if (/^[A-Za-z]:/.test(trimmed)) return undefined;
  if (/[\u0000-\u001f]/.test(trimmed)) return undefined;
  const segments = trimmed.split('/');
  const kept: string[] = [];
  for (const segment of segments) {
    // '.' 是无操作段（模型常写 ./ 前缀），收敛掉；'..' 是逃逸，拒绝；空段（//）拒绝。
    if (segment === '.') continue;
    if (segment.length === 0 || segment === '..') return undefined;
    kept.push(segment);
  }
  if (kept.length === 0) return undefined;
  return kept.join('/');
}
