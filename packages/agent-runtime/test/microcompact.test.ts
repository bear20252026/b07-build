// 一个文件=一种作用：微压缩决策的验收测试。
//
// 覆盖五组：总开关与缺省姿态、时间触发的边界、保留窗口与名额、可清白名单的
// fail-closed 语义、幂等与 token 统计。

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolDescriptor } from '@awo/protocol';
import {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  DEFAULT_GAP_THRESHOLD_MINUTES,
  DEFAULT_KEEP_RECENT,
  DEFAULT_MICROCOMPACT_CONFIG,
  decideMicrocompact,
  isResultClearable,
  type MicrocompactConfig,
  type ToolResultEntry,
} from '../src/microcompact.js';

const MINUTE = 60_000;

/** 造一条可清结果。 */
function result(
  id: string,
  tokens = 100,
  extra: Partial<ToolResultEntry> = {},
): ToolResultEntry {
  return { id, toolName: 'FileRead', estimatedTokens: tokens, clearable: true, ...extra };
}

function enabled(overrides: Partial<MicrocompactConfig> = {}): MicrocompactConfig {
  return {
    enabled: true,
    gapThresholdMinutes: DEFAULT_GAP_THRESHOLD_MINUTES,
    keepRecent: DEFAULT_KEEP_RECENT,
    ...overrides,
  };
}

/** 一个距最后助手消息已超过阈值的时间点。 */
const NOW = 10_000_000_000;
const LONG_AGO = NOW - 90 * MINUTE;

// ─────────────────────── 缺省姿态 ───────────────────────

test('缺省配置是关闭的，且不清理任何内容', () => {
  // 静默改变上下文会让人难以定位问题，故默认必须是关闭。
  assert.equal(DEFAULT_MICROCOMPACT_CONFIG.enabled, false);

  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [result('a'), result('b'), result('c')],
  });

  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'disabled');
  assert.deepEqual(decision.clearIds, []);
  assert.equal(decision.estimatedTokensSaved, 0);
});

test('未触发时 keepIds 覆盖全部输入', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [result('a'), result('b')],
    config: enabled(),
  });

  // 间隔 90 分钟 > 60 分钟阈值，但只有 2 条且保留 5 条 → 无可清。
  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'nothing_clearable');
  assert.deepEqual(decision.keepIds, ['a', 'b']);
});

test('没有助手消息时不触发', () => {
  const decision = decideMicrocompact({
    now: NOW,
    results: [result('a'), result('b'), result('c'), result('d'), result('e'), result('f')],
    config: enabled(),
  });

  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'no_assistant_message');
  assert.equal(decision.gapMinutes, undefined);
});

// ─────────────────────── 时间触发边界 ───────────────────────

test('间隔恰好等于阈值时触发（边界含等号）', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: NOW - 60 * MINUTE,
    results: [result('a'), result('b'), result('c'), result('d'), result('e'), result('f')],
    config: enabled({ gapThresholdMinutes: 60 }),
  });

  assert.equal(decision.triggered, true);
  assert.equal(decision.gapMinutes, 60);
});

test('间隔差 1 毫秒未达阈值时不触发', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: NOW - (60 * MINUTE - 1),
    results: [result('a'), result('b'), result('c'), result('d'), result('e'), result('f')],
    config: enabled({ gapThresholdMinutes: 60 }),
  });

  // 缓存可能仍热，此时清反而会打断可复用的前缀。
  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'below_gap_threshold');
});

test('时钟回拨导致的负间隔视为未达阈值', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: NOW + 10 * MINUTE,
    results: [result('a'), result('b'), result('c'), result('d'), result('e'), result('f')],
    config: enabled(),
  });

  // 时间不可信时不动手，而不是按"负间隔 < 阈值"或"溢出"行为。
  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'below_gap_threshold');
});

test('阈值可配置，非默认值同样生效', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: NOW - 5 * MINUTE,
    results: [result('a'), result('b'), result('c')],
    config: enabled({ gapThresholdMinutes: 3, keepRecent: 1 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a', 'b']);
});

// ─────────────────────── 保留窗口 ───────────────────────

test('保留最近 N 条，更早的清空', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [result('a'), result('b'), result('c'), result('d'), result('e'), result('f')],
    config: enabled({ keepRecent: 2 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a', 'b', 'c', 'd']);
  assert.deepEqual(decision.keepIds, ['e', 'f']);
});

test('keepRecent 为 0 时仍保留最近 1 条，不得清空全部', () => {
  // 清空全部会让模型失去工作上下文——这是灾难性退化，配置错误也不能触发。
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [result('a'), result('b'), result('c')],
    config: enabled({ keepRecent: 0 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a', 'b']);
  assert.deepEqual(decision.keepIds, ['c']);
});

test('keepRecent 为负数时同样夹到 1', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [result('a'), result('b')],
    config: enabled({ keepRecent: -5 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a']);
  assert.deepEqual(decision.keepIds, ['b']);
});

test('可清条目不足保留数时不清任何内容', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [result('a'), result('b')],
    config: enabled({ keepRecent: 5 }),
  });

  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'nothing_clearable');
});

// ────────────────── 可清白名单（fail-closed） ──────────────────

test('未声明 clearable 的条目恒保留', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [
      { id: 'user-intent', toolName: 'UserPrompt', estimatedTokens: 50 },
      result('a'),
      result('b'),
      result('c'),
    ],
    config: enabled({ keepRecent: 1 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a', 'b']);
  // 用户意图不在清理范围内——它是意图本身，清掉等于失忆。
  assert.ok(decision.keepIds.includes('user-intent'));
});

test('clearable: false 的条目恒保留', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [
      result('a'),
      result('pinned', 100, { clearable: false }),
      result('b'),
      result('c'),
    ],
    config: enabled({ keepRecent: 1 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a', 'b']);
  assert.ok(decision.keepIds.includes('pinned'));
});

test('不可清条目不占用保留名额', () => {
  // 若不可清条目占名额，"保留最近 1 条"就会被它挤掉，与意图不符。
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [
      result('a'),
      result('b'),
      result('pinned-1', 100, { clearable: false }),
      result('pinned-2', 100, { clearable: false }),
    ],
    config: enabled({ keepRecent: 1 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a']);
  assert.deepEqual(decision.keepIds, ['b', 'pinned-1', 'pinned-2']);
});

test('全部不可清时不触发', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [
      { id: 'u1', toolName: 'UserPrompt', estimatedTokens: 10 },
      { id: 'u2', toolName: 'UserPrompt', estimatedTokens: 10 },
    ],
    config: enabled({ keepRecent: 1 }),
  });

  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'nothing_clearable');
  assert.equal(decision.estimatedTokensSaved, 0);
});

// ─────────────────────── 幂等与统计 ───────────────────────

test('已清理的条目再次决策时不计入省下的 token', () => {
  const results = [
    result('a', 1000, { alreadyCleared: true }),
    result('b', 200),
    result('c', 300),
  ];

  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results,
    config: enabled({ keepRecent: 1 }),
  });

  assert.equal(decision.triggered, true);
  // a 已清过 → 不再进 clearIds，也不虚报它那 1000 token。
  assert.deepEqual(decision.clearIds, ['b']);
  assert.equal(decision.estimatedTokensSaved, 200);
});

test('第二次决策不再产出相同的清理清单（幂等）', () => {
  const results = [
    result('a', 100),
    result('b', 100),
    result('c', 100),
    result('d', 100),
  ];
  const config = enabled({ keepRecent: 1 });

  const first = decideMicrocompact({ now: NOW, lastAssistantAt: LONG_AGO, results, config });
  assert.deepEqual(first.clearIds, ['a', 'b', 'c']);

  // 应用第一次决策后，把清除过的条目标记为 alreadyCleared 再决策。
  const applied = results.map((entry) =>
    first.clearIds.includes(entry.id) ? { ...entry, alreadyCleared: true } : entry,
  );
  const second = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: applied,
    config,
  });

  assert.equal(second.triggered, false);
  assert.equal(second.skipReason, 'nothing_clearable');
  assert.equal(second.estimatedTokensSaved, 0);
});

test('省下的 token 是本次真正清除条的合计', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [
      result('a', 1500),
      result('b', 2500),
      result('c', 700),
      result('d', 999),
    ],
    config: enabled({ keepRecent: 1 }),
  });

  assert.equal(decision.triggered, true);
  assert.deepEqual(decision.clearIds, ['a', 'b', 'c']);
  assert.equal(decision.estimatedTokensSaved, 1500 + 2500 + 700);
});

test('clearIds 与 keepIds 恰好划分输入集合，无重叠无遗漏', () => {
  const results = [
    result('a'),
    result('pinned', 100, { clearable: false }),
    result('b'),
    result('c'),
    result('d'),
  ];
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results,
    config: enabled({ keepRecent: 2 }),
  });

  const union = [...decision.clearIds, ...decision.keepIds].sort();
  assert.deepEqual(union, ['a', 'b', 'c', 'd', 'pinned']);
  assert.equal(new Set(union).size, union.length, '两侧不得有重复 id');
});

test('占位文案是显式标记而非空字符串', () => {
  // 模型看到空内容会误以为工具返回了空，从而编造结论。
  assert.notEqual(CLEARED_TOOL_RESULT_PLACEHOLDER, '');
  assert.ok(CLEARED_TOOL_RESULT_PLACEHOLDER.length > 0);
});

test('决策不修改输入数组', () => {
  const results = [result('a'), result('b'), result('c')];
  const snapshot = JSON.parse(JSON.stringify(results));
  decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results,
    config: enabled({ keepRecent: 1 }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(results)), snapshot);
});

test('空结果集时不触发', () => {
  const decision = decideMicrocompact({
    now: NOW,
    lastAssistantAt: LONG_AGO,
    results: [],
    config: enabled(),
  });

  assert.equal(decision.triggered, false);
  assert.equal(decision.skipReason, 'nothing_clearable');
  assert.deepEqual(decision.clearIds, []);
});

test('默认常量值符合与缓存 TTL 对齐的设计意图', () => {
  // 60 分钟与服务端 prompt 缓存 1h TTL 对齐：保证缓存已过期才清，避免打断热缓存。
  assert.equal(DEFAULT_GAP_THRESHOLD_MINUTES, 60);
  assert.equal(DEFAULT_KEEP_RECENT, 5);
});

// ──────────────── 从工具描述符派生可清性 ────────────────

/** 造一份最小可用的描述符片段；只保留可清性判定用到的三个字段。 */
function clearability(
  overrides: Partial<
    Pick<ToolDescriptor, 'readOnly' | 'isReadOnly' | 'sideEffectScope'>
  > = {},
): Pick<ToolDescriptor, 'readOnly' | 'isReadOnly' | 'sideEffectScope'> {
  return { readOnly: true, sideEffectScope: 'none', ...overrides };
}

test('只读且作用域为 none 的结果可清', () => {
  // 既只读、又作用域为 none，才是真正可再生的。
  assert.equal(isResultClearable(clearability()), true);
});

test('只读但作用到工作区的结果不可清', () => {
  assert.equal(isResultClearable(clearability({ sideEffectScope: 'workspace' })), false);
});

test('只读但作用到外部世界的结果不可清', () => {
  // 外部检索的结果是外部快照，重跑未必得到同样内容——清掉就永久丢失当时的事实。
  assert.equal(isResultClearable(clearability({ sideEffectScope: 'external' })), false);
});

test('非只读的结果不可清', () => {
  assert.equal(isResultClearable(clearability({ readOnly: false })), false);
});

test('描述符缺失时不可清（fail-closed）', () => {
  assert.equal(isResultClearable(undefined), false);
});

test('作用域检查先于只读检查：非 none 时即便只读也不可清', () => {
  // 两个条件缺一不可，任一条不满足都返回 false。
  assert.equal(
    isResultClearable(clearability({ readOnly: true, sideEffectScope: 'external' })),
    false,
  );
});

test('逐入参只读判定会传导到可清性：ls 可清、rm 不可清', () => {
  // 这是把基线 4 的函数式 readOnly 接进微压缩的收益点：
  // 同一个 shell 工具，只读调用的结果可清，写入调用的结果不可清。
  const shell = clearability({
    readOnly: false,
    isReadOnly: (input) => String(input.command).trim() === 'ls',
  });

  assert.equal(isResultClearable(shell, { command: 'ls' }), true);
  assert.equal(isResultClearable(shell, { command: 'rm -rf /' }), false);
});

test('isReadOnly 抛异常时可清性收敛为 false，不向上传播', () => {
  const broken = clearability({
    isReadOnly: () => {
      throw new Error('策略表故障');
    },
  });
  assert.equal(isResultClearable(broken, {}), false);
});

test('真实 ToolDescriptor 形态可直接传入', () => {
  // 与 packages/protocol 的 ToolDescriptor 结构兼容：文件读取类工具可清。
  const fileRead: ToolDescriptor = {
    name: 'FileRead',
    capability: 'document.parse',
    defaultRisk: 'low',
    readOnly: true,
    destructive: false,
    sideEffectScope: 'none',
    resultBudgetChars: 20_000,
    timeoutMs: 5_000,
    concurrentSafe: true,
  };
  assert.equal(isResultClearable(fileRead), true);

  // 写入类工具不可清。
  const fileWrite: ToolDescriptor = {
    ...fileRead,
    name: 'FileWrite',
    readOnly: false,
    destructive: true,
    sideEffectScope: 'workspace',
  };
  assert.equal(isResultClearable(fileWrite), false);
});

test('协议层的真实 ToolDescriptor 无需 cast 即可传入', () => {
  // 编译期断言：适配器的入参是真实 ToolDescriptor 的**结构超集**，
  // 故调用方可以直接把注册表里的描述符传进来，不必手工挑字段。
  // 若任一方改了字段名或类型，这里会先炸——而不是等运行期静默返回 false。
  const descriptor: ToolDescriptor = {
    name: 'FileRead',
    capability: 'document.parse',
    defaultRisk: 'low',
    readOnly: true,
    destructive: false,
    sideEffectScope: 'none',
    resultBudgetChars: 20_000,
    timeoutMs: 5_000,
    concurrentSafe: true,
  };

  assert.equal(isResultClearable(descriptor), true);
  assert.equal(
    isResultClearable({ ...descriptor, sideEffectScope: 'external' }),
    false,
  );
});
