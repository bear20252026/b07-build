// 一个文件=一种作用：远端 git 市场来源解析器（可注入 GitRunner + 本地缓存 + ref 校验）。
//
// 设计借鉴（非源码移植）：从克隆目录的 `.git/config` 反解仓库地址作为来源出处（provenance）
// 的思路，借鉴自一个 AGPL-3.0-or-later 的第三方项目（项目名与许可见 THIRD-PARTY-NOTICES.md
// 「语义借用（非源码移植）」小节）。本文件为 b07 独立实现，未复制任何上游代码。
//
// b07 形态：
//   - git 调用经 GitRunner 注入：测试用假实现即可完全不出网、不真跑 git。
//   - 生产实现用 child_process.execFile（参数数组、不经 shell），设超时，并禁用交互式凭据提示。
//   - ref 先校验为安全的分支/标签名，避免把 `--upload-pack=...` 之类注入 git 命令行。
//   - 克隆到可注入的本地缓存目录（缓存键含 ref）；同来源并发加载做进程内去重。
//   - 解析器组合了本地解析器：directory / file 直接委托，git / github / git-like url 走克隆。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LoadedMarketplace, MarketplaceSourceResolver } from './plugin-marketplace.js';
import { createLocalMarketplaceSourceResolver, loadMarketplaceManifestFromDirectory, PluginMarketplaceError } from './plugin-marketplace.js';
import type { MarketplaceSource, PluginMarketplaceManifest, PluginSourceProvenance } from './plugin-marketplace-types.js';

/** 单次 git 命令的执行结果（不抛异常，由调用方按 exitCode 判定）。 */
export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** git 执行器注入点：生产实现走子进程，测试用假实现（完全不出网、不真跑 git）。 */
export interface GitRunner {
  run(args: readonly string[], options: { cwd?: string; timeoutMs: number }): Promise<GitCommandResult>;
}

export interface ChildProcessGitRunnerOptions {
  /** git 可执行文件名或路径；默认 `git`。 */
  executable?: string;
  /** 额外环境变量（默认仅叠加禁用交互式凭据提示的 GIT_TERMINAL_PROMPT=0）。 */
  env?: NodeJS.ProcessEnv;
}

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** 超时被杀的约定退出码（与 GNU timeout 一致），便于诊断区分超时与普通失败。 */
export const GIT_TIMEOUT_EXIT_CODE = 124;

/**
 * 生产 GitRunner：用 `execFile` 以参数数组调用 git，**不经 shell**，故不存在命令拼接注入。
 * 关闭交互式凭据提示（GIT_TERMINAL_PROMPT=0），避免无人值守时挂起等待输入。
 */
export function createChildProcessGitRunner(options: ChildProcessGitRunnerOptions = {}): GitRunner {
  const executable = options.executable ?? 'git';
  const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env };
  return {
    run(args, { cwd, timeoutMs }): Promise<GitCommandResult> {
      return new Promise<GitCommandResult>((resolveResult) => {
        execFile(
          executable,
          [...args],
          { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: MAX_BUFFER_BYTES, env: baseEnv },
          (error, stdout, stderr) => {
            const killed = Boolean(error && (error as { killed?: boolean }).killed);
            const rawCode = error ? (error as { code?: unknown }).code : 0;
            const exitCode = killed ? GIT_TIMEOUT_EXIT_CODE : typeof rawCode === 'number' ? rawCode : error ? 1 : 0;
            resolveResult({ exitCode, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          },
        );
      });
    },
  };
}

/** ref 安全校验：仅允许分支/标签常见字符，禁止前导 `-`、`..`、结尾 `.lock` 等危险形态。 */
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/u;

export function isSafeGitRef(ref: string): boolean {
  if (!SAFE_REF_PATTERN.test(ref)) return false;
  if (ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock') || ref.endsWith('.')) return false;
  if (ref.includes('@{') || ref.includes('//')) return false;
  return true;
}

/** 去除仓库地址内嵌凭据、SSH 简写归一为 https、去掉末尾 `.git`，用于 provenance 展示。 */
export function sanitizeRepoUrl(raw: string): string {
  let value = raw.trim();
  const ssh = /^git@([^:]+):(.+)$/u.exec(value);
  if (ssh) value = `https://${ssh[1]}/${ssh[2]}`;
  value = value.replace(/(:\/\/)[^/@]*@/u, '$1');
  value = value.replace(/\/+$/u, '');
  value = value.replace(/\.git$/u, '');
  return value;
}

/**
 * 从克隆目录的 `.git/config` 反解远程仓库地址（设计借鉴点）。
 * 只读文件、不调 git；取首个 `url = ...` 值并做凭据脱敏。
 */
export function readGitRemoteUrl(rootPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(rootPath, '.git', 'config'), 'utf8');
  } catch {
    return undefined;
  }
  const match = /^\s*url\s*=\s*(.+)$/mu.exec(text);
  if (!match) return undefined;
  const sanitized = sanitizeRepoUrl(match[1] as string);
  return sanitized.length > 0 ? sanitized : undefined;
}

/** 归一化后的 git 来源：仓库地址 + 可选 ref + 原始来源类型。 */
interface NormalizedGitSource {
  kind: MarketplaceSource['source'];
  url: string;
  ref?: string;
}

/** 判断一个 `url` 分支是否形如 git 仓库地址（否则本解析器无法处理，给出可读诊断）。 */
function isGitLikeUrl(url: string): boolean {
  return url.endsWith('.git') || url.startsWith('git@') || url.startsWith('ssh://') || url.startsWith('git://');
}

function normalizeGitSource(source: MarketplaceSource): NormalizedGitSource | undefined {
  if (source.source === 'git') return { kind: 'git', url: source.url, ...(source.ref ? { ref: source.ref } : {}) };
  if (source.source === 'github') {
    const repo = source.repo.replace(/\.git$/u, '');
    return { kind: 'github', url: `https://github.com/${repo}.git`, ...(source.ref ? { ref: source.ref } : {}) };
  }
  if (source.source === 'url') {
    return isGitLikeUrl(source.url) ? { kind: 'url', url: source.url } : undefined;
  }
  return undefined;
}

/** 缓存键：`git-<sha256(url\0ref) 前 16 位>`，只含十六进制与短横线，天然是安全目录名。 */
function gitCacheKey(url: string, ref?: string): string {
  const digest = createHash('sha256').update(`${url}\0${ref ?? ''}`, 'utf8').digest('hex').slice(0, 16);
  return `git-${digest}`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface GitMarketplaceSourceResolverOptions {
  /** git 执行器；默认 child_process 实现。测试注入假实现即完全不出网。 */
  git?: GitRunner;
  /** 本地缓存根目录；默认 `~/.awo/plugin-cache`。 */
  cacheRoot?: string;
  /** 单次 git 命令超时（毫秒）；默认 120000。 */
  timeoutMs?: number;
}

/**
 * 远端 git 市场来源解析器：克隆到本地缓存后按既有 `loadMarketplaceManifestFromDirectory` 加载。
 * 缓存命中直接复用；同一来源并发加载共享同一个在途 Promise（进程内去重，避免重复克隆）。
 */
export class GitMarketplaceSourceResolver implements MarketplaceSourceResolver {
  private readonly git: GitRunner;
  private readonly cacheRoot: string;
  private readonly timeoutMs: number;
  private readonly local: MarketplaceSourceResolver;
  private readonly inflight = new Map<string, Promise<LoadedMarketplace>>();

  constructor(options: GitMarketplaceSourceResolverOptions = {}) {
    this.git = options.git ?? createChildProcessGitRunner();
    this.cacheRoot = options.cacheRoot ?? join(homedir(), '.awo', 'plugin-cache');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.local = createLocalMarketplaceSourceResolver();
  }

  load(source: MarketplaceSource): Promise<LoadedMarketplace> | LoadedMarketplace {
    // 本地来源直接委托既有本地解析器，保持默认行为不变。
    if (source.source === 'directory' || source.source === 'file') return this.local.load(source);

    const normalized = normalizeGitSource(source);
    if (!normalized) {
      throw new PluginMarketplaceError(
        'plugin_marketplace_source_unsupported',
        `本解析器只处理 git 来源；${source.source} 形态的地址不是 git 仓库：${
          'url' in source ? source.url : JSON.stringify(source)
        }`,
      );
    }
    if (normalized.ref !== undefined && !isSafeGitRef(normalized.ref)) {
      throw new PluginMarketplaceError(
        'plugin_marketplace_source_unsupported',
        `市场来源 ref 非法（只允许安全的分支/标签名）：${normalized.ref}`,
      );
    }

    const key = gitCacheKey(normalized.url, normalized.ref);
    const cacheDir = join(this.cacheRoot, key);

    // 同一来源并发加载共享同一个在途 Promise（进程内去重，避免重复克隆）。
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = this.resolveSource(normalized, cacheDir).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** 缓存命中则复用（仍需 rev-parse 取 commit），否则克隆。 */
  private async resolveSource(normalized: NormalizedGitSource, cacheDir: string): Promise<LoadedMarketplace> {
    const cached = this.tryCache(cacheDir);
    if (cached) {
      return { manifest: cached, rootPath: cacheDir, provenance: await this.readProvenance(cacheDir, normalized) };
    }
    return this.materialize(normalized, cacheDir);
  }

  /** 缓存命中：目录存在且可加载出合法市场清单时复用（失败按未命中处理，走重新克隆）。 */
  private tryCache(cacheDir: string): PluginMarketplaceManifest | undefined {
    if (!existsSync(cacheDir)) return undefined;
    try {
      return loadMarketplaceManifestFromDirectory(cacheDir);
    } catch {
      return undefined;
    }
  }

  /** 克隆到临时目录 → 校验清单 → 原子改名进缓存目录；任一步失败都清理临时目录。 */
  private async materialize(normalized: NormalizedGitSource, cacheDir: string): Promise<LoadedMarketplace> {
    mkdirSync(this.cacheRoot, { recursive: true });
    const tempDir = mkdtempSync(join(this.cacheRoot, '.tmp-'));
    try {
      const args = ['clone', '--depth', '1'];
      if (normalized.ref !== undefined) args.push('--branch', normalized.ref);
      args.push('--', normalized.url, tempDir);
      const cloned = await this.git.run(args, { timeoutMs: this.timeoutMs });
      if (cloned.exitCode !== 0) {
        const reason = cloned.exitCode === GIT_TIMEOUT_EXIT_CODE ? `超时（>${this.timeoutMs}ms）` : `退出码 ${cloned.exitCode}`;
        throw new PluginMarketplaceError(
          'plugin_marketplace_source_unavailable',
          `git clone 失败（${reason}）：${firstLine(cloned.stderr) || normalized.url}`,
        );
      }
      // 先按既有加载器校验清单，非法即整体失败（不留半成品缓存）。
      const manifest = loadMarketplaceManifestFromDirectory(tempDir);
      const provenance = await this.readProvenance(tempDir, normalized);
      if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
      renameSync(tempDir, cacheDir);
      return { manifest, rootPath: cacheDir, provenance };
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      if (error instanceof PluginMarketplaceError) throw error;
      throw new PluginMarketplaceError('plugin_marketplace_source_unavailable', `git 市场来源加载失败：${errorMessage(error)}`);
    }
  }

  /** 异步取 commit（`git rev-parse HEAD`）；仓库地址优先从 `.git/config` 反解。 */
  private async readProvenance(rootPath: string, normalized: NormalizedGitSource): Promise<PluginSourceProvenance> {
    const repoUrl = readGitRemoteUrl(rootPath) ?? sanitizeRepoUrl(normalized.url);
    const provenance: PluginSourceProvenance = {
      kind: normalized.kind,
      ...(repoUrl ? { repoUrl } : {}),
      ...(normalized.ref !== undefined ? { ref: normalized.ref } : {}),
    };
    try {
      const rev = await this.git.run(['rev-parse', 'HEAD'], { cwd: rootPath, timeoutMs: this.timeoutMs });
      const commit = rev.exitCode === 0 ? rev.stdout.trim() : '';
      if (/^[0-9a-f]{7,64}$/iu.test(commit)) provenance.commit = commit;
    } catch {
      // commit 为可选信息，取不到就不登记。
    }
    return provenance;
  }
}

/** 工厂：与既有 `createLocalMarketplaceSourceResolver` 同形，便于注入 PluginMarketplace。 */
export function createGitMarketplaceSourceResolver(options: GitMarketplaceSourceResolverOptions = {}): MarketplaceSourceResolver {
  return new GitMarketplaceSourceResolver(options);
}
