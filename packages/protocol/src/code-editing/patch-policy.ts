// 一个文件=一种作用：结构化 Patch 的策略——把解析结果筛成「可安全执行的计划」。
//
// 第一期边界（缺省，故意从窄）：只允许「更新已存在文件」；add / delete / move 一律拒绝。
// 第二期（allowStructureChanges 显式开启）：放开 add / delete / move，但仍然——
// - 路径必须是工作区内的相对 POSIX 路径：拒绝绝对路径、盘符、`..` 逃逸、空段；
// - add 的目标必须不存在；delete / move 的源必须存在；move 的目标必须不存在；
//   存在性由调用方提供的 existingFiles 集合判定（Rust workspace_files 已不列出不
//   穿越 symlink 的路径），真正的磁盘级复核在原生 commit 时再做一遍；
// - 同一文件的重复目标拒绝（无论哪种操作）。
//
// 策略只产出计划，不做 I/O；写入走原生批量事务（stage → 审批 → commit）。

import type { PatchChunk, ParsedPatch } from './patch-parser.js';

export interface PatchFileUpdate {
  path: string;
  chunks: PatchChunk[];
}

/** 计划中的一条可执行操作；kind 决定原生侧的写入方式。 */
export type SafePatchOperation =
  | { kind: 'update'; path: string; chunks: PatchChunk[]; movePath?: string }
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string };

export interface PatchPlanRejection {
  path: string;
  /** 稳定的拒绝原因码，供审批界面与审计记录使用。 */
  reason:
    | 'phase1-update-only'
    | 'path-escapes-workspace'
    | 'file-not-found'
    | 'file-already-exists'
    | 'duplicate-patch-target';
  detail?: string;
}

export interface SafePatchPlan {
  operations: SafePatchOperation[];
  rejections: PatchPlanRejection[];
}

export interface PatchPlanOptions {
  /** 当前工作区内「真实存在且非符号链接」的相对路径集合（由 Rust workspace_files 列出）。 */
  existingFiles: ReadonlySet<string>;
  /** 第二期开关：允许 add / delete / move。缺省 false（第一期行为不变）。 */
  allowStructureChanges?: boolean;
}

export function planPatchSections(sections: readonly ParsedPatch[], options: PatchPlanOptions): SafePatchPlan {
  const operations: SafePatchOperation[] = [];
  const rejections: PatchPlanRejection[] = [];
  const seen = new Set<string>();

  const reject = (path: string, reason: PatchPlanRejection['reason'], detail?: string): void => {
    rejections.push({ path, reason, ...(detail === undefined ? {} : { detail }) });
  };

  const structureAllowed = options.allowStructureChanges === true;

  for (const section of sections) {
    if (section.type === 'add') {
      const path = normalizeRelativePath(section.path);
      if (!structureAllowed) {
        reject(section.path, 'phase1-update-only', 'add file');
        continue;
      }
      if (path === undefined) {
        reject(section.path, 'path-escapes-workspace');
        continue;
      }
      if (options.existingFiles.has(path)) {
        reject(path, 'file-already-exists');
        continue;
      }
      if (seen.has(path)) {
        reject(path, 'duplicate-patch-target');
        continue;
      }
      seen.add(path);
      operations.push({ kind: 'add', path, contents: section.contents });
      continue;
    }
    if (section.type === 'delete') {
      const path = normalizeRelativePath(section.path);
      if (!structureAllowed) {
        reject(section.path, 'phase1-update-only', 'delete file');
        continue;
      }
      if (path === undefined) {
        reject(section.path, 'path-escapes-workspace');
        continue;
      }
      if (!options.existingFiles.has(path)) {
        reject(path, 'file-not-found');
        continue;
      }
      if (seen.has(path)) {
        reject(path, 'duplicate-patch-target');
        continue;
      }
      seen.add(path);
      operations.push({ kind: 'delete', path });
      continue;
    }

    // update（可能带 move）
    const sourcePath = normalizeRelativePath(section.path);
    const movePath = section.movePath !== undefined ? normalizeRelativePath(section.movePath) : undefined;
    if (sourcePath === undefined || (section.movePath !== undefined && movePath === undefined)) {
      reject(section.path, 'path-escapes-workspace');
      continue;
    }
    if (section.movePath !== undefined && !structureAllowed) {
      reject(sourcePath, 'phase1-update-only', 'move file');
      continue;
    }
    if (movePath !== undefined && options.existingFiles.has(movePath)) {
      reject(movePath, 'file-already-exists');
      continue;
    }
    if (!options.existingFiles.has(sourcePath)) {
      reject(sourcePath, 'file-not-found');
      continue;
    }
    if (seen.has(sourcePath) || (movePath !== undefined && seen.has(movePath))) {
      reject(sourcePath, 'duplicate-patch-target');
      continue;
    }
    seen.add(sourcePath);
    if (movePath !== undefined) seen.add(movePath);
    operations.push({
      kind: 'update',
      path: sourcePath,
      chunks: section.chunks,
      ...(movePath !== undefined ? { movePath } : {}),
    });
  }

  return { operations, rejections };
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
