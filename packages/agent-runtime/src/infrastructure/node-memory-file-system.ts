// 记忆 recall 的 Node 文件系统适配器。
//
// 与 `memory-recall.ts` 的分层理由：纯逻辑模块只认 `MemoryFileSystemPort` 三个只读动作，
// 于是它能在浏览器上下文（工作台）无 Node 依赖地复用，也能在测试里用假端口精确控制
// 「读取失败 / 符号链接 / 超大文件」等边界。本文件是 Node 侧的默认实现。
//
// 安全姿态（与项目既有 workspace_files 同一套纪律）：
//   - 只读，永不写入。
//   - 符号链接**不跟随**：记忆目录里指向工作区外部的链接不得被读到（`lstat` 判定）。
//   - 单文件读取有硬上限，超限直接抛（由上层逐项收敛成「这条读不到」）。

import { lstatSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type {
  MemoryDirectoryEntry,
  MemoryFileContent,
  MemoryFileSystemPort,
  MemoryHead,
  MemoryStat,
} from '../memory-recall-contract.js';

/** 单个记忆文件的读取上限（4 MiB）。超过即视为配置错误，而不是需要截断的正常内容。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface NodeMemoryFileSystemOptions {
  /** 每个文件的读取上限；便于测试。 */
  readonly maxFileBytes?: number;
}

export class NodeMemoryFileSystem implements MemoryFileSystemPort {
  private readonly maxFileBytes: number;

  constructor(options: NodeMemoryFileSystemOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  }

  listDirectory(path: string): readonly MemoryDirectoryEntry[] {
    const dirents: Dirent[] = readdirSync(path, { withFileTypes: true });
    const entries: MemoryDirectoryEntry[] = [];
    for (const dirent of dirents) {
      const fullPath = join(path, dirent.name);
      let kind: MemoryDirectoryEntry['kind'];
      if (dirent.isDirectory()) kind = 'directory';
      else if (dirent.isFile()) kind = 'file';
      else if (dirent.isSymbolicLink()) kind = 'symlink';
      else kind = 'other';
      if (kind === 'directory') {
        // 目录自身的可读性在递归时才发现；此处先按目录登记，失败由上层 catch 收敛。
        entries.push({ path: fullPath, kind });
        continue;
      }
      entries.push({ path: fullPath, kind });
    }
    return entries;
  }

  stat(path: string): MemoryStat {
    // lstat 不跟随链接：清单里只收录「本身是普通文件」的项，符号链接在读取阶段再判。
    const stats = lstatSync(path);
    return {
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      isFile: stats.isFile(),
    };
  }

  readHead(path: string, limitLines: number): MemoryHead {
    const content = this.readTextFile(path);
    const lines = content.split('\n');
    return {
      content: lines.slice(0, limitLines).join('\n'),
      totalLines: lines.length,
    };
  }

  readWhole(path: string): MemoryFileContent {
    // 不跟随符号链接：指向工作区外部的记忆文件不得被读入上下文。
    // 这里用 lstat（不跟随）而非 stat：清单生成与读取之间文件可能被换成链接（TOCTOU），
    // 故读取时再判一次，且给出与「不是普通文件」不同的明确错误。
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error('记忆文件是符号链接，拒绝读取');
    if (!stats.isFile()) throw new Error('记忆路径不是普通文件');
    if (stats.size > this.maxFileBytes) {
      throw new Error(`记忆文件超过 ${this.maxFileBytes} 字节上限`);
    }
    // readFileSync 在 size 快照之后文件变大时也不会越过我们自己的上限检查太远：
    // 这里读的是同一 inode，Node 会读完整内容，故再按实际字节数判一次。
    const buffer = readFileSync(path);
    if (buffer.byteLength > this.maxFileBytes) {
      throw new Error(`记忆文件超过 ${this.maxFileBytes} 字节上限`);
    }
    return {
      content: buffer.toString('utf8'),
      sizeBytes: buffer.byteLength,
      mtimeMs: stats.mtimeMs,
    };
  }

  private readTextFile(path: string): string {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error('记忆文件是符号链接，拒绝读取');
    if (stats.size > this.maxFileBytes) {
      throw new Error(`记忆文件超过 ${this.maxFileBytes} 字节上限`);
    }
    return readFileSync(path, 'utf8');
  }
}
