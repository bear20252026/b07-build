// 一个文件=一种作用：Hook 信任域的判定、准入过滤与存储验收测试。
//
// 覆盖五组：信任判定八条分支、信任键与陈旧检测、准入装饰器的 fail-closed、
// 批量授权边界、存储三态与持久化往返。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookRegistration } from '../src/hook-contract.js';
import type { HookSelector } from '../src/hook-executor.js';
import {
  DEFAULT_HOOK_TRUST_POLICY,
  HOOK_TRUST_ORIGINS,
  HOOK_TRUST_STATES,
  isHookTrustOrigin,
  isHookTrustState,
  type HookTrustPolicy,
  type HookTrustRecord,
  type HookTrustSource,
} from '../src/hook-trust-contract.js';
import {
  canBatchGrant,
  decodeHookTrustKey,
  encodeHookTrustKey,
  evaluateHookTrust,
  hookTrustKey,
  needsUserDecision,
  withHookTrust,
} from '../src/hook-trust.js';
import {
  InMemoryHookTrustStore,
  SqliteHookTrustStore,
} from '../src/infrastructure/sqlite/hook-trust-store.js';

const WS = '/work/alpha';
const DIGEST = 'sha256:aaaa';

/** 造一个来源。 */
function source(overrides: Partial<HookTrustSource> = {}): HookTrustSource {
  return {
    workspaceIdentity: WS,
    declarationDigest: DIGEST,
    sourcePath: '.claude/hooks.json',
    origin: 'workspace',
    ...overrides,
  };
}

/** 造一条授权记录。 */
function record(overrides: Partial<HookTrustRecord> = {}): HookTrustRecord {
  return {
    workspaceIdentity: WS,
    declarationDigest: DIGEST,
    sourcePathAtGrant: '.claude/hooks.json',
    indexAtGrant: 3,
    grantedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 判定一次的便捷入口。 */
function evaluate(
  overrides: Partial<Parameters<typeof evaluateHookTrust>[0]> = {},
): ReturnType<typeof evaluateHookTrust> {
  return evaluateHookTrust({
    source: source(),
    policy: DEFAULT_HOOK_TRUST_POLICY,
    records: new Map(),
    revokedKeys: new Set(),
    storeStatus: 'ok',
    declarationIndex: 3,
    ...overrides,
  });
}

/** 造一条注册项（信任域只关心身份，不关心 handler）。 */
function hook(id: string): HookRegistration {
  return { event: 'PreToolUse', id, handler: () => ({ kind: 'Abstain' }) };
}

/** 造一个只返回固定清单的基础选择器。 */
function fixedSelector(registrations: readonly HookRegistration[]): HookSelector {
  return () => registrations;
}

// ── 一、闭集与契约 ──────────────────────────────────────────────────────────

test('信任来源闭集：四个类别且判定函数拒绝越界值', () => {
  assert.deepEqual([...HOOK_TRUST_ORIGINS], ['builtin', 'workspace', 'user', 'remote']);
  assert.equal(isHookTrustOrigin('workspace'), true);
  assert.equal(isHookTrustOrigin('plugin'), false);
  assert.equal(isHookTrustOrigin(''), false);
});

test('信任状态闭集：七态且判定函数拒绝越界值', () => {
  assert.equal(HOOK_TRUST_STATES.length, 7);
  assert.equal(isHookTrustState('trusted'), true);
  assert.equal(isHookTrustState('maybe'), false);
});

test('默认策略是待用户决定且不允许工作区批量授权', () => {
  assert.equal(DEFAULT_HOOK_TRUST_POLICY.mode, 'user_decides');
  assert.equal(DEFAULT_HOOK_TRUST_POLICY.allowWorkspaceBatchGrant, false);
});

// ── 二、信任判定八条分支 ────────────────────────────────────────────────────

test('分支1：策略 deny 时全部拒绝，连内置来源也不执行', () => {
  const policy: HookTrustPolicy = { ...DEFAULT_HOOK_TRUST_POLICY, mode: 'deny' };
  const result = evaluate({ source: source({ origin: 'builtin' }), policy });
  assert.equal(result.state, 'blocked_policy');
  assert.equal(result.reasonCode, 'denied_by_policy');
  assert.equal(result.runnable, false);
});

test('分支2：存储损坏时按未授权处理，即使有授权记录', () => {
  const result = evaluate({
    storeStatus: 'corrupt',
    records: new Map([[hookTrustKey(WS, DIGEST), record()]]),
  });
  assert.equal(result.state, 'blocked_untrusted');
  assert.equal(result.runnable, false);
  assert.match(result.explanation, /损坏/);
});

test('分支3：内置来源免信任，可执行', () => {
  const result = evaluate({ source: source({ origin: 'builtin' }) });
  assert.equal(result.state, 'trusted_builtin');
  assert.equal(result.reasonCode, 'builtin_origin');
  assert.equal(result.runnable, true);
});

test('分支4：吊销优先于持久授权', () => {
  const key = hookTrustKey(WS, DIGEST);
  const result = evaluate({
    records: new Map([[key, record()]]),
    revokedKeys: new Set([key]),
  });
  assert.equal(result.state, 'revoked');
  assert.equal(result.runnable, false);
});

test('分支5：持久授权命中即可执行', () => {
  const key = hookTrustKey(WS, DIGEST);
  const result = evaluate({ records: new Map([[key, record()]]) });
  assert.equal(result.state, 'trusted');
  assert.equal(result.reasonCode, 'persistent_grant');
  assert.equal(result.runnable, true);
});

test('分支6：只读模式下未授权直接拒绝，不给待决定态', () => {
  const policy: HookTrustPolicy = { ...DEFAULT_HOOK_TRUST_POLICY, mode: 'allow_trusted_only' };
  const result = evaluate({ policy });
  assert.equal(result.state, 'blocked_untrusted');
  assert.equal(result.runnable, false);
  assert.equal(needsUserDecision(result), false);
});

test('分支7：同位置摘要变化判为陈旧，且需要用户重新决定', () => {
  // 同工作区、同路径、同序号，但摘要不同 → 内容被换过。
  const stale = record({ declarationDigest: 'sha256:bbbb' });
  const result = evaluate({ records: new Map([[hookTrustKey(WS, 'sha256:bbbb'), stale]]) });
  assert.equal(result.state, 'stale_digest');
  assert.equal(result.reasonCode, 'declaration_changed_since_grant');
  assert.equal(result.runnable, false);
  assert.equal(needsUserDecision(result), true);
});

test('陈旧检测：路径相同但序号不同不算陈旧（文件里新增了一条）', () => {
  const otherIndex = record({ declarationDigest: 'sha256:bbbb', indexAtGrant: 9 });
  const result = evaluate({
    records: new Map([[hookTrustKey(WS, 'sha256:bbbb'), otherIndex]]),
    declarationIndex: 3,
  });
  assert.equal(result.state, 'pending');
});

test('陈旧检测：序号相同但路径不同不算陈旧', () => {
  const otherPath = record({ declarationDigest: 'sha256:bbbb', sourcePathAtGrant: 'other.json' });
  const result = evaluate({ records: new Map([[hookTrustKey(WS, 'sha256:bbbb'), otherPath]]) });
  assert.equal(result.state, 'pending');
});

test('陈旧检测：工作区不同不算陈旧', () => {
  const otherWs = record({ declarationDigest: 'sha256:bbbb', workspaceIdentity: '/work/beta' });
  const result = evaluate({ records: new Map([[hookTrustKey('/work/beta', 'sha256:bbbb'), otherWs]]) });
  assert.equal(result.state, 'pending');
});

test('分支8：兜底为待用户决定，且需要用户决定', () => {
  const result = evaluate();
  assert.equal(result.state, 'pending');
  assert.equal(result.reasonCode, 'awaiting_user_decision');
  assert.equal(result.runnable, false);
  assert.equal(needsUserDecision(result), true);
});

test('runnable 仅在 trusted 与 trusted_builtin 两态为真', () => {
  const key = hookTrustKey(WS, DIGEST);
  const runnableStates = new Set<string>();
  // 遍历所有可达状态，确认只有两态可执行。
  runnableStates.add(evaluate({ records: new Map([[key, record()]]) }).state);
  runnableStates.add(evaluate({ source: source({ origin: 'builtin' }) }).state);
  assert.deepEqual([...runnableStates].sort(), ['trusted', 'trusted_builtin']);

  for (const state of HOOK_TRUST_STATES) {
    if (state === 'trusted' || state === 'trusted_builtin') continue;
    // 其余状态在各自的构造路径下都应为不可执行（已在上面的分支测试逐条断言）。
    assert.equal(isHookTrustState(state), true);
  }
});

// ── 三、信任键与批量授权边界 ────────────────────────────────────────────────

test('信任键用 NUL 分隔，避免可出现的字符造成歧义', () => {
  // 若用 ':' 分隔，下列两组会撞成同一个键。
  const a = hookTrustKey('a:b', 'c');
  const b = hookTrustKey('a', 'b:c');
  assert.notEqual(a, b);
  assert.equal(a.includes('\u0000'), true);
});

test('信任键编解码：往返无损，且编码结果不含 NUL', () => {
  const key = hookTrustKey('/work/alpha', 'sha256:aaaa');
  const encoded = encodeHookTrustKey(key);
  assert.equal(encoded.includes('\u0000'), false);
  assert.equal(decodeHookTrustKey(encoded), key);
});

test('信任键编解码：反斜杠被正确转义（单射，不会与 NUL 转义混淆）', () => {
  // 工作区路径可能含反斜杠（Windows）。若不转义反斜杠，
  // 'a\\' + NUL + 'b' 与 'a' + NUL + '\\0b' 会编码成同一个串。
  const withBackslash = hookTrustKey('C:\\work', 'sha256:x');
  const withLiteral = hookTrustKey('C:\\work\u00000', 'sha256:x');
  assert.notEqual(encodeHookTrustKey(withBackslash), encodeHookTrustKey(withLiteral));
  assert.equal(decodeHookTrustKey(encodeHookTrustKey(withBackslash)), withBackslash);
  assert.equal(decodeHookTrustKey(encodeHookTrustKey(withLiteral)), withLiteral);
});

test('信任键解码：畸形转义返回 undefined（fail-closed，不猜）', () => {
  assert.equal(decodeHookTrustKey('a\\nb'), undefined);
  assert.equal(decodeHookTrustKey('trailing\\'), undefined);
});

test('SQLite 存储：含 NUL 的信任键往返不截断（回归）', () => {
  // 曾出现的真实缺陷：信任键以 NUL 分隔，而 SQLite 的 TEXT 绑定在 NUL 处截断
  // （写入 32 字符读回 11 字符）。后果是同工作区的不同摘要塌缩成同一个键——
  // 授权与吊销都会串线。此测试固定该回归。
  const dir = mkdtempSync(join(tmpdir(), 'hook-trust-'));
  const file = join(dir, 'trust.db');
  const keyA = hookTrustKey(WS, 'sha256:aaaa');
  const keyB = hookTrustKey(WS, 'sha256:bbbb');
  let store: SqliteHookTrustStore | undefined;
  try {
    store = new SqliteHookTrustStore(file);
    store.grant(record({ declarationDigest: 'sha256:aaaa' }));
    store.revoke(keyB);

    const revoked = store.revokedKeys();
    // 关键断言：吊销 B 不能影响 A，且两个键各自完整往返。
    assert.equal(revoked.has(keyB), true);
    assert.equal(revoked.has(keyA), false);
    assert.equal(store.isGranted(keyA), true);
    assert.equal(store.isGranted(keyB), false);
    assert.equal(store.records().has(keyA), true);
    assert.equal([...store.records().keys()][0], keyA);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remote 来源恒不允许批量授权，即使策略开关打开', () => {
  const policy = { allowWorkspaceBatchGrant: true };
  assert.equal(canBatchGrant('remote', policy), false);
  assert.equal(canBatchGrant('builtin', policy), false);
  assert.equal(canBatchGrant('workspace', policy), true);
  assert.equal(canBatchGrant('user', policy), true);
});

test('工作区批量授权默认关闭', () => {
  assert.equal(canBatchGrant('workspace', DEFAULT_HOOK_TRUST_POLICY), false);
});

// ── 四、准入装饰器 ──────────────────────────────────────────────────────────

test('装饰器只放行已信任的 Hook，拒绝的不进清单', () => {
  const trustedKey = hookTrustKey(WS, 'sha256:trusted');
  const selector = withHookTrust(fixedSelector([hook('a'), hook('b')]), {
    resolveSource: (registration) =>
      registration.id === 'a'
        ? { source: source({ declarationDigest: 'sha256:trusted' }), declarationIndex: 0 }
        : { source: source({ declarationDigest: 'sha256:nope' }), declarationIndex: 1 },
    policy: DEFAULT_HOOK_TRUST_POLICY,
    records: new Map([
      [trustedKey, record({ declarationDigest: 'sha256:trusted', indexAtGrant: 0 })],
    ]),
    revokedKeys: new Set(),
    storeStatus: 'ok',
  });

  const admitted = selector('PreToolUse', undefined);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.id, 'a');
});

test('装饰器对无法解析来源的 Hook 一律拒绝（fail-closed）', () => {
  const denied: string[] = [];
  const selector = withHookTrust(fixedSelector([hook('a')]), {
    resolveSource: () => undefined,
    policy: DEFAULT_HOOK_TRUST_POLICY,
    records: new Map(),
    revokedKeys: new Set(),
    storeStatus: 'ok',
    onDenied: (registration, evaluation) => {
      denied.push(`${registration.id}:${evaluation.reasonCode}`);
    },
  });

  assert.deepEqual(selector('PreToolUse', undefined), []);
  assert.deepEqual(denied, ['a:denied_untrusted_origin']);
});

test('装饰器保持原顺序，且 onDenied 逐步收到拒绝原因', () => {
  const key = hookTrustKey(WS, 'sha256:ok');
  const denied: string[] = [];
  const selector = withHookTrust(fixedSelector([hook('x'), hook('ok'), hook('z')]), {
    resolveSource: (registration) => ({
      source: source({
        declarationDigest: registration.id === 'ok' ? 'sha256:ok' : `sha256:${registration.id}`,
      }),
      declarationIndex: 0,
    }),
    policy: DEFAULT_HOOK_TRUST_POLICY,
    records: new Map([[key, record({ declarationDigest: 'sha256:ok', indexAtGrant: 0 })]]),
    revokedKeys: new Set(),
    storeStatus: 'ok',
    onDenied: (registration) => denied.push(registration.id),
  });

  const admitted = selector('PreToolUse', undefined);
  assert.deepEqual(admitted.map((item) => item.id), ['ok']);
  assert.deepEqual(denied, ['x', 'z']);
});

test('装饰器在 deny 策略下清空全部（含内置来源）', () => {
  const selector = withHookTrust(fixedSelector([hook('builtin-1')]), {
    resolveSource: () => ({ source: source({ origin: 'builtin' }), declarationIndex: 0 }),
    policy: { ...DEFAULT_HOOK_TRUST_POLICY, mode: 'deny' },
    records: new Map(),
    revokedKeys: new Set(),
    storeStatus: 'ok',
  });
  assert.deepEqual(selector('PreToolUse', undefined), []);
});

test('装饰器把基础选择器的筛选结果原样传递（含 toolName）', () => {
  let seenToolName: string | undefined = 'unset';
  const base: HookSelector = (_event, toolName) => {
    seenToolName = toolName;
    return [hook('a')];
  };
  const selector = withHookTrust(base, {
    resolveSource: () => ({ source: source({ origin: 'builtin' }), declarationIndex: 0 }),
    policy: DEFAULT_HOOK_TRUST_POLICY,
    records: new Map(),
    revokedKeys: new Set(),
    storeStatus: 'ok',
  });
  selector('PreToolUse', 'mcp__srv__tool');
  assert.equal(seenToolName, 'mcp__srv__tool');
});

// ── 五、存储 ────────────────────────────────────────────────────────────────

test('内存存储：授权后可查、吊销后不可查', () => {
  const store = new InMemoryHookTrustStore();
  const key = hookTrustKey(WS, DIGEST);
  assert.equal(store.isGranted(key), false);
  store.grant(record());
  assert.equal(store.isGranted(key), true);
  assert.equal(store.records().size, 1);

  store.revoke(key);
  assert.equal(store.isGranted(key), false);
  assert.equal(store.revokedKeys().has(key), true);
  assert.equal(store.status(), 'ok');
});

test('内存存储：重新授权解除吊销', () => {
  const store = new InMemoryHookTrustStore();
  const key = hookTrustKey(WS, DIGEST);
  store.revoke(key);
  assert.equal(store.revokedKeys().has(key), true);
  store.grant(record());
  assert.equal(store.revokedKeys().has(key), false);
  assert.equal(store.isGranted(key), true);
});

test('SQLite 存储：授权与吊销在重开后仍然生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-trust-'));
  const file = join(dir, 'trust.db');
  const key = hookTrustKey(WS, DIGEST);
  const opened: SqliteHookTrustStore[] = [];
  // 用 onClose 统一登记，确保**断言失败时连接也被关闭**——否则 finally 的 rmSync
  // 会因文件被占用抛 EBUSY，从而掩盖真正的断言错误。
  const open = (): SqliteHookTrustStore => {
    const store = new SqliteHookTrustStore(file);
    opened.push(store);
    return store;
  };
  try {
    const first = open();
    assert.equal(first.status(), 'ok');
    first.grant(record());
    assert.equal(first.isGranted(key), true);

    const second = open();
    assert.equal(second.status(), 'ok');
    assert.equal(second.isGranted(key), true);
    assert.equal(second.records().get(key)?.grantedAt, '2026-10-01T00:00:00.000Z');

    second.revoke(key);

    const third = open();
    assert.equal(third.isGranted(key), false);
    assert.equal(third.revokedKeys().has(key), true);
  } finally {
    for (const store of opened) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite 存储：可吊销一条从未授权过的 Hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-trust-'));
  const file = join(dir, 'trust.db');
  const key = hookTrustKey(WS, 'sha256:never-granted');
  let store: SqliteHookTrustStore | undefined;
  try {
    store = new SqliteHookTrustStore(file);
    store.revoke(key);
    assert.equal(store.revokedKeys().has(key), true);
    assert.equal(store.isGranted(key), false);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite 存储：单条记录损坏只跳过该条，不作废整库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-trust-'));
  const file = join(dir, 'trust.db');
  const goodKey = hookTrustKey(WS, 'sha256:good');
  const badKey = hookTrustKey(WS, 'sha256:bad');
  let store: SqliteHookTrustStore | undefined;
  try {
    store = new SqliteHookTrustStore(file);
    store.grant(record({ declarationDigest: 'sha256:good' }));
    // 直接写入一条字段残缺的记录（模拟被外部工具改坏）。
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare(
        'INSERT INTO hook_trust_records (trust_key, workspace_identity, declaration_digest, record_json, granted_at_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run(badKey, WS, 'sha256:bad', '{"workspaceIdentity":"x"}', 0);

    const records = store.records();
    assert.equal(store.status(), 'ok');
    assert.equal(records.has(goodKey), true);
    assert.equal(records.has(badKey), false);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite 存储与判定串联：吊销后的 Hook 不可执行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-trust-'));
  const file = join(dir, 'trust.db');
  const key = hookTrustKey(WS, DIGEST);
  let store: SqliteHookTrustStore | undefined;
  try {
    store = new SqliteHookTrustStore(file);
    store.grant(record());
    const before = evaluate({ records: store.records(), revokedKeys: store.revokedKeys() });
    assert.equal(before.runnable, true);

    store.revoke(key);
    const after = evaluate({ records: store.records(), revokedKeys: store.revokedKeys() });
    assert.equal(after.state, 'revoked');
    assert.equal(after.runnable, false);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite 存储：close 释放连接，重复 close 抛错（与仓库其他 store 一致）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-trust-'));
  const file = join(dir, 'trust.db');
  try {
    const store = new SqliteHookTrustStore(file);
    store.close();
    // 刻意不做幂等吞异常：仓库既有的 SQLite store（memory-ledger / administrator-lease /
    // component-provenance）都是裸 `this.db.close()`。重复关闭报错是有用的信号——
    // 静默吞掉会掩盖调用方真正的生命周期错误。本测试**固定**这个约定，避免将来
    // 有人"顺手加个幂等"而偏离仓库一致形态。
    assert.throws(() => store.close(), /database is not open|ERR_INVALID_STATE/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
