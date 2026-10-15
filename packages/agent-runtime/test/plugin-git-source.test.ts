// 一个文件=一种作用：远端 git 市场来源解析器的单元测试（假 GitRunner，完全不出网、不真跑 git）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChildProcessGitRunner,
  createGitMarketplaceSourceResolver,
  GIT_TIMEOUT_EXIT_CODE,
  InMemoryMcpAppStore,
  InMemoryMcpManifestStore,
  InMemoryPluginMarketplaceStore,
  isSafeGitRef,
  McpAppRegistry,
  McpRegistry,
  PluginMarketplace,
  PluginMarketplaceError,
  readGitRemoteUrl,
  sanitizeRepoUrl,
  type GitCommandResult,
  type GitRunner,
} from '../src/index.js';

const COMMIT = 'a'.repeat(40);

type GitHandler = (args: readonly string[], options: { cwd?: string; timeoutMs: number }) => GitCommandResult | Promise<GitCommandResult>;

/** 假 GitRunner：记录调用参数，行为由 handler 决定；测试因此完全不出网、不真跑 git。 */
class FakeGitRunner implements GitRunner {
  readonly calls: { args: readonly string[]; cwd?: string; timeoutMs: number }[] = [];

  constructor(private readonly handler: GitHandler) {}

  async run(args: readonly string[], options: { cwd?: string; timeoutMs: number }): Promise<GitCommandResult> {
    this.calls.push({ args, ...(options.cwd ? { cwd: options.cwd } : {}), timeoutMs: options.timeoutMs });
    return this.handler(args, options);
  }
}

/** 在克隆目标目录里落一个最小 git 市场（清单 + 插件包 + .git/config）。 */
function writeClonedRepo(root: string, options: { repoUrl?: string; marketplaceName?: string; pluginName?: string } = {}): void {
  const marketplaceName = options.marketplaceName ?? 'git-market';
  const pluginName = options.pluginName ?? 'hello-plugin';
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({ name: marketplaceName, description: 'git 市场', plugins: [{ name: pluginName, version: '2.0.0' }] }, null, 2)}\n`,
    'utf8',
  );
  mkdirSync(join(root, pluginName, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, pluginName, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      { name: pluginName, version: '2.0.0', mcpApp: { serverId: 'awo.demo', htmlResourceUri: 'ui://hello/index.html', requestedToolNames: ['echo'] } },
      null,
      2,
    )}\n`,
    'utf8',
  );
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(
    join(root, '.git', 'config'),
    `[remote "origin"]\n\turl = ${options.repoUrl ?? 'https://github.com/awo-org/plugins.git'}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    'utf8',
  );
}

/** 模拟 git 成功：clone 时落文件，rev-parse 时回 commit。 */
function successfulGitHandler(repoUrl?: string): GitHandler {
  return (args) => {
    if (args[0] === 'clone') {
      const dest = args[args.length - 1] as string;
      writeClonedRepo(dest, repoUrl ? { repoUrl } : {});
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${COMMIT}\n`, stderr: '' };
    return { exitCode: 1, stdout: '', stderr: `unexpected args: ${args.join(' ')}` };
  };
}

function createAppRegistry(): McpAppRegistry {
  const serverStore = new InMemoryMcpManifestStore();
  const servers = new McpRegistry(serverStore);
  servers.register({
    id: 'awo.demo',
    displayName: 'Demo MCP server',
    connection: { transport: 'stdio', executable: 'node', args: [] },
    declaredTools: [{ name: 'echo', description: '回显', capability: 'model.chat', risk: 'low' }],
    sourceDigest: 'a'.repeat(64),
    reviewedBy: 'local-admin',
    at: 1,
  });
  servers.enable('awo.demo', 'local-admin', 2);
  return new McpAppRegistry(new InMemoryMcpAppStore(), serverStore);
}

test('git 来源解析器：github 简写克隆 → 加载清单 → 登记 provenance（含 .git/config 反解地址）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-git-'));
  try {
    const git = new FakeGitRunner(successfulGitHandler('https://github.com/awo-org/plugins.git'));
    const resolver = createGitMarketplaceSourceResolver({ git, cacheRoot: join(root, 'cache'), timeoutMs: 5_000 });
    const marketplace = new PluginMarketplace({
      store: new InMemoryPluginMarketplaceStore(),
      appRegistry: createAppRegistry(),
      sourceResolver: resolver,
      nowIso: () => '2026-01-01T00:00:00.000Z',
    });

    const added = await marketplace.addMarketplace({ source: 'awo-org/plugins' });
    assert.equal(added.ok, true, JSON.stringify(added.diagnostics));
    assert.equal(added.record?.id, 'git-market');
    assert.deepEqual(added.record?.source, { source: 'github', repo: 'awo-org/plugins' });

    const installed = await marketplace.installPlugin({ pluginId: 'hello-plugin@git-market' });
    assert.equal(installed.ok, true, JSON.stringify(installed.diagnostics));
    assert.equal(installed.installed?.appId, 'mcpapp-hello-plugin');
    // provenance：repoUrl 从克隆目录的 .git/config 反解（去掉 .git 后缀），commit 来自 rev-parse HEAD。
    assert.deepEqual(installed.installed?.provenance, {
      kind: 'github',
      repoUrl: 'https://github.com/awo-org/plugins',
      commit: COMMIT,
    });

    // 缓存命中：add + install 各加载一次，但 clone 只发生一次。
    assert.equal(git.calls.filter((call) => call.args[0] === 'clone').length, 1);
    assert.equal(git.calls.filter((call) => call.args[0] === 'rev-parse').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git 来源解析器：ref 以 --branch 传给 git；不合法 ref 被拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-git-ref-'));
  try {
    const git = new FakeGitRunner(successfulGitHandler());
    const resolver = createGitMarketplaceSourceResolver({ git, cacheRoot: join(root, 'cache') });

    const loaded = await resolver.load({ source: 'git', url: 'https://example.com/market.git', ref: 'v1.2.3' });
    assert.equal(loaded.manifest.name, 'git-market');
    const clone = git.calls.find((call) => call.args[0] === 'clone');
    const args = clone?.args ?? [];
    assert.deepEqual(args.slice(0, 6), ['clone', '--depth', '1', '--branch', 'v1.2.3', '--']);
    assert.equal(args[6], 'https://example.com/market.git');
    assert.equal(args.length, 8);
    assert.match(args[7] as string, /\.tmp-/u);
    assert.equal(loaded.provenance?.ref, 'v1.2.3');

    // 危险 ref：前导 `-`（会被 git 当成选项）、含 `..`、结尾 `.lock`。
    for (const ref of ['--upload-pack=evil', '-x', 'a..b', 'main.lock', 'feature//x', 'a@{0}']) {
      assert.equal(isSafeGitRef(ref), false, `应判为不安全：${ref}`);
      assert.throws(
        () => resolver.load({ source: 'git', url: 'https://example.com/market.git', ref }),
        (error: unknown) => error instanceof PluginMarketplaceError && /ref 非法/u.test(error.message),
      );
    }
    assert.equal(isSafeGitRef('release/v1.2.3'), true);
    assert.equal(isSafeGitRef('v1.2.3'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git 来源解析器：非 git 的 http url 与 npm 来源给出可读诊断', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-git-unsupported-'));
  try {
    const resolver = createGitMarketplaceSourceResolver({ git: new FakeGitRunner(successfulGitHandler()), cacheRoot: join(root, 'cache') });
    assert.throws(
      () => resolver.load({ source: 'url', url: 'https://example.com/catalog.json' }),
      (error: unknown) => error instanceof PluginMarketplaceError && error.code === 'plugin_marketplace_source_unsupported',
    );
    assert.throws(
      () => resolver.load({ source: 'npm', package: '@awo/plugin' }),
      (error: unknown) => error instanceof PluginMarketplaceError && error.code === 'plugin_marketplace_source_unsupported',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git 来源解析器：clone 失败与超时都归为 plugin_marketplace_source_unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-git-fail-'));
  try {
    const failing = createGitMarketplaceSourceResolver({
      git: new FakeGitRunner(() => ({ exitCode: 128, stdout: '', stderr: 'fatal: repository not found' })),
      cacheRoot: join(root, 'cache-fail'),
    });
    const failedMarketplace = new PluginMarketplace({ store: new InMemoryPluginMarketplaceStore(), appRegistry: createAppRegistry(), sourceResolver: failing });
    const failed = await failedMarketplace.addMarketplace({ source: 'https://example.com/missing.git' });
    assert.equal(failed.ok, false);
    assert.equal(failed.diagnostics[0]?.code, 'plugin_marketplace_source_unavailable');
    assert.match(failed.diagnostics[0]?.message ?? '', /repository not found/u);

    const timedOut = createGitMarketplaceSourceResolver({
      git: new FakeGitRunner(() => ({ exitCode: GIT_TIMEOUT_EXIT_CODE, stdout: '', stderr: '' })),
      cacheRoot: join(root, 'cache-timeout'),
      timeoutMs: 50,
    });
    const timedOutMarketplace = new PluginMarketplace({ store: new InMemoryPluginMarketplaceStore(), appRegistry: createAppRegistry(), sourceResolver: timedOut });
    const timeoutResult = await timedOutMarketplace.addMarketplace({ source: 'https://example.com/slow.git' });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.diagnostics[0]?.code, 'plugin_marketplace_source_unavailable');
    assert.match(timeoutResult.diagnostics[0]?.message ?? '', /超时/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git 来源解析器：并发加载同一来源只克隆一次（进程内去重）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-git-concurrent-'));
  try {
    const git = new FakeGitRunner(successfulGitHandler());
    const resolver = createGitMarketplaceSourceResolver({ git, cacheRoot: join(root, 'cache') });
    const [first, second] = await Promise.all([
      resolver.load({ source: 'git', url: 'https://example.com/same.git' }),
      resolver.load({ source: 'git', url: 'https://example.com/same.git' }),
    ]);
    assert.equal(first.manifest.name, second.manifest.name);
    assert.equal(git.calls.filter((call) => call.args[0] === 'clone').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provenance 工具：sanitizeRepoUrl 去凭据/归一 ssh，readGitRemoteUrl 从 .git/config 反解', () => {
  assert.equal(sanitizeRepoUrl('https://user:placeholder@example.com/org/repo.git'), 'https://example.com/org/repo');
  assert.equal(sanitizeRepoUrl('git@github.com:awo-org/plugins.git'), 'https://github.com/awo-org/plugins');
  assert.equal(sanitizeRepoUrl('https://example.com/org/repo.git/'), 'https://example.com/org/repo');

  const root = mkdtempSync(join(tmpdir(), 'awo-git-provenance-'));
  try {
    writeClonedRepo(root, { repoUrl: 'https://user:placeholder@example.com/org/repo.git' });
    assert.equal(readGitRemoteUrl(root), 'https://example.com/org/repo');
    assert.equal(readGitRemoteUrl(join(root, 'nope')), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('生产 GitRunner：超时杀进程并映射为约定退出码（不起 git、不出网）', async () => {
  const runner = createChildProcessGitRunner({ executable: process.execPath });
  const started = Date.now();
  const result = await runner.run(['-e', 'setTimeout(() => {}, 3000)'], { timeoutMs: 200 });
  assert.equal(result.exitCode, GIT_TIMEOUT_EXIT_CODE);
  assert.ok(Date.now() - started < 3_000, '超时应远早于子进程自然结束');
});
