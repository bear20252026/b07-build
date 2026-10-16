// 一个文件=一种作用：Hook 链的注册、条件匹配与链式执行验收测试。
//
// 覆盖四组：契约闭集、注册期校验、when 条件解析与匹配、执行器的四条纪律
// （顺序、阻塞即停、改写叠加、异常即阻塞）。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOOK_EVENTS,
  isHookEvent,
  type HookInvocation,
  type HookOutcome,
  type HookRegistration,
} from '../src/hook-contract.js';
import {
  HookRegistry,
  matchesWhen,
  parseWhen,
  validateWhenCondition,
} from '../src/hook-registry.js';
import { executeHookChain, type HookSelector } from '../src/hook-executor.js';

/** 造一条 Hook：只关心 event / id / when / handler。 */
function hook(
  event: HookRegistration['event'],
  id: string,
  handler: (invocation: HookInvocation) => HookOutcome,
  when?: string,
): HookRegistration {
  return when === undefined
    ? { event, id, handler }
    : { event, id, when, handler };
}

/** 从注册表取选择器。 */
function selectorOf(registry: HookRegistry): HookSelector {
  return (event, toolName) => registry.matching(event, toolName);
}

// ─────────────────────────── 事件闭集 ───────────────────────────

test('事件闭集包含四个已接入的事件', () => {
  assert.deepEqual([...HOOK_EVENTS], [
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'SessionStart',
  ]);
});

test('isHookEvent 拒绝未知事件名', () => {
  assert.equal(isHookEvent('PreToolUse'), true);
  assert.equal(isHookEvent('NotAnEvent'), false);
  // 大小写敏感：外部配置写错大小写不该被静默接受。
  assert.equal(isHookEvent('pretooluse'), false);
});

// ─────────────────────── when 条件解析 ───────────────────────

test('精确匹配形式解析正确', () => {
  assert.deepEqual(parseWhen('Tool(Bash)'), { kind: 'exact', value: 'Bash' });
});

test('前缀通配形式解析正确', () => {
  assert.deepEqual(parseWhen('Tool(mcp__*)'), {
    kind: 'prefix',
    prefix: 'mcp__',
  });
});

test('语法非法一律返回 null', () => {
  // 缺括号、缺前缀、空内容、星号不在末尾、多个星号、空前缀。
  for (const bad of [
    'Bash',
    'Tool(',
    'Tool()',
    'Tool(a)b',
    'Tool(*a)',
    'Tool(a*b)',
    'Tool(a**b)',
    'Tool(*)',
    'Tool(a b)',
  ]) {
    assert.equal(parseWhen(bad), null, `${bad} 应判为语法非法`);
  }
});

test('validateWhenCondition 只对语法错误报错', () => {
  assert.equal(validateWhenCondition(undefined), undefined);
  assert.equal(validateWhenCondition('Tool(Bash)'), undefined);
  assert.equal(validateWhenCondition('Tool('), 'syntax');
});

test('无条件的 Hook 恒匹配', () => {
  assert.equal(matchesWhen(undefined, 'Bash'), true);
  assert.equal(matchesWhen(undefined, undefined), true);
});

test('有条件但无工具名时不匹配（fail-closed）', () => {
  // 不知道工具名就不该跑带工具条件的 Hook——宁可少跑。
  assert.equal(matchesWhen('Tool(Bash)', undefined), false);
});

test('精确条件只匹配同名工具', () => {
  assert.equal(matchesWhen('Tool(Bash)', 'Bash'), true);
  assert.equal(matchesWhen('Tool(Bash)', 'BashTool'), false);
  assert.equal(matchesWhen('Tool(Bash)', 'bash'), false);
});

test('前缀通配匹配所有 MCP 工具', () => {
  assert.equal(matchesWhen('Tool(mcp__*)', 'mcp__srv__read'), true);
  assert.equal(matchesWhen('Tool(mcp__*)', 'Bash'), false);
});

test('语法非法的条件在运行期按不匹配处理', () => {
  // 畸形配置不得意外扩大作用面。
  assert.equal(matchesWhen('Tool(', 'Bash'), false);
});

// ─────────────────────── 注册期校验 ───────────────────────

test('注册成功返回 null', () => {
  const registry = new HookRegistry();
  const err = registry.register(hook('PreToolUse', 'h1', () => ({ kind: 'Allow' })));
  assert.equal(err, null);
  assert.equal(registry.size, 1);
});

test('同一事件下 id 重复被拒', () => {
  const registry = new HookRegistry();
  registry.register(hook('PreToolUse', 'dup', () => ({ kind: 'Allow' })));
  const err = registry.register(hook('PreToolUse', 'dup', () => ({ kind: 'Allow' })));
  assert.deepEqual(err, { code: 'hook_id_duplicate', event: 'PreToolUse', id: 'dup' });
  assert.equal(registry.size, 1, '重复注册不得改变总数');
});

test('不同事件下同名 id 允许', () => {
  const registry = new HookRegistry();
  assert.equal(registry.register(hook('PreToolUse', 'same', () => ({ kind: 'Allow' }))), null);
  assert.equal(registry.register(hook('PostToolUse', 'same', () => ({ kind: 'Allow' }))), null);
  assert.equal(registry.size, 2);
});

test('when 语法非法在注册期即被拒', () => {
  const registry = new HookRegistry();
  const err = registry.register(
    hook('PreToolUse', 'bad', () => ({ kind: 'Allow' }), 'Tool(*mid*)'),
  );
  assert.deepEqual(err, {
    code: 'hook_when_invalid',
    event: 'PreToolUse',
    id: 'bad',
    when: 'Tool(*mid*)',
  });
  assert.equal(registry.size, 0);
});

test('registrationsFor 返回只读快照，外部改写不污染注册表', () => {
  const registry = new HookRegistry();
  registry.register(hook('PreToolUse', 'a', () => ({ kind: 'Allow' })));
  const snapshot = registry.registrationsFor('PreToolUse');
  assert.equal(snapshot.length, 1);

  // 每次都是新数组，而非内部存储的引用。
  assert.notEqual(registry.registrationsFor('PreToolUse'), snapshot);

  // 真正要防的是：外部改写快照不得影响注册表。绕过 TS 的 readonly 来验证。
  (snapshot as HookRegistration[]).push(
    hook('PreToolUse', '注入', () => ({ kind: 'Allow' })),
  );
  assert.equal(registry.registrationsFor('PreToolUse').length, 1);
  assert.equal(registry.size, 1);
});

test('matching 只返回条件命中的 Hook 且保持注册顺序', () => {
  const registry = new HookRegistry();
  registry.register(hook('PreToolUse', 'any', () => ({ kind: 'Allow' })));
  registry.register(hook('PreToolUse', 'bash-only', () => ({ kind: 'Allow' }), 'Tool(Bash)'));
  registry.register(hook('PreToolUse', 'mcp-only', () => ({ kind: 'Allow' }), 'Tool(mcp__*)'));

  const forBash = registry.matching('PreToolUse', 'Bash').map((h) => h.id);
  assert.deepEqual(forBash, ['any', 'bash-only']);

  const forMcp = registry.matching('PreToolUse', 'mcp__s__t').map((h) => h.id);
  assert.deepEqual(forMcp, ['any', 'mcp-only']);
});

// ─────────────────────── 执行器 ───────────────────────

test('无 Hook 时原样放行', () => {
  const registry = new HookRegistry();
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { cmd: 'ls' },
  });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.resolvedInput, { cmd: 'ls' });
  assert.equal(result.additionalContext, undefined);
  assert.deepEqual(result.appliedHookIds, []);
});

test('Allow 放行并收集上下文', () => {
  const registry = new HookRegistry();
  registry.register(
    hook('PreToolUse', 'a', () => ({ kind: 'Allow', additionalContext: '提示一' })),
  );
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  assert.equal(result.blocked, false);
  assert.equal(result.additionalContext, '提示一');
  assert.deepEqual(result.appliedHookIds, ['a']);
});

test('多条 Allow 的上下文按顺序拼接', () => {
  const registry = new HookRegistry();
  registry.register(hook('PreToolUse', 'a', () => ({ kind: 'Allow', additionalContext: '一' })));
  registry.register(hook('PreToolUse', 'b', () => ({ kind: 'Allow', additionalContext: '二' })));
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  assert.equal(result.additionalContext, '一\n\n二');
});

test('Modify 改写后的入参成为最终入参', () => {
  const registry = new HookRegistry();
  registry.register(
    hook('PreToolUse', 'rewrite', () => ({
      kind: 'Modify',
      updatedInput: { cmd: 'ls ./tmp' },
    })),
  );
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { cmd: 'rm -rf /' },
  });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.resolvedInput, { cmd: 'ls ./tmp' });
});

test('Modify 是合并而非整体替换（保留其它字段）', () => {
  const registry = new HookRegistry();
  registry.register(
    hook('PreToolUse', 'patch', () => ({
      kind: 'Modify',
      updatedInput: { cmd: 'ls' },
    })),
  );
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { cmd: 'rm', timeoutMs: 5000, cwd: '/work' },
  });
  assert.deepEqual(result.resolvedInput, { cmd: 'ls', timeoutMs: 5000, cwd: '/work' });
});

test('改写可叠加：后一个 Hook 看到前一个的结果', () => {
  const registry = new HookRegistry();
  registry.register(
    hook('PreToolUse', 'first', () => ({ kind: 'Modify', updatedInput: { step: 1 } })),
  );
  registry.register(
    hook('PreToolUse', 'second', (invocation) => ({
      kind: 'Modify',
      updatedInput: { step: (invocation.toolInput?.step as number) + 1 },
    })),
  );
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { step: 0 },
  });
  assert.deepEqual(result.resolvedInput, { step: 2 });
});

test('Block 即停：后续 Hook 不再运行', () => {
  const registry = new HookRegistry();
  let secondRan = false;
  registry.register(hook('PreToolUse', 'blocker', () => ({ kind: 'Block', reason: '不允许' })));
  registry.register(
    hook('PreToolUse', 'after', () => {
      secondRan = true;
      return { kind: 'Allow' };
    }),
  );
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  assert.equal(result.blocked, true);
  assert.equal(result.blockReason, '不允许');
  assert.equal(secondRan, false, '阻塞后不得再运行后续 Hook');
});

test('Block 时不返回上下文（避免语义混乱）', () => {
  const registry = new HookRegistry();
  registry.register(hook('PreToolUse', 'a', () => ({ kind: 'Allow', additionalContext: '前一条' })));
  registry.register(hook('PreToolUse', 'b', () => ({ kind: 'Block', reason: '停' })));
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  assert.equal(result.blocked, true);
  assert.equal(result.additionalContext, undefined);
});

test('Abstain 跳过但不阻塞', () => {
  const registry = new HookRegistry();
  registry.register(hook('PreToolUse', 'quiet', () => ({ kind: 'Abstain' })));
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.appliedHookIds, []);
  assert.deepEqual(result.skippedHookIds, ['quiet']);
});

test('handler 抛错即阻塞（fail-closed）', () => {
  const registry = new HookRegistry();
  registry.register(
    hook('PreToolUse', 'boom', () => {
      throw new Error('策略崩了');
    }),
  );
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  // 关键：抛错绝不能被当成"放行"——那会把"策略没跑成"变成"策略通过"。
  assert.equal(result.blocked, true);
  assert.match(result.blockReason ?? '', /hook-error:boom:/);
  assert.match(result.blockReason ?? '', /策略崩了/);
});

test('handler 抛非 Error 值也能产出可读原因', () => {
  const registry = new HookRegistry();
  registry.register(
    hook('PreToolUse', 'weird', () => {
      throw 'just a string';
    }),
  );
  const result = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  assert.equal(result.blocked, true);
  assert.match(result.blockReason ?? '', /just a string/);
});

test('执行顺序与注册顺序一致', () => {
  const registry = new HookRegistry();
  const order: string[] = [];
  for (const id of ['c', 'a', 'b']) {
    registry.register(
      hook('PreToolUse', id, () => {
        order.push(id);
        return { kind: 'Allow' };
      }),
    );
  }
  executeHookChain(selectorOf(registry), 'PreToolUse', { event: 'PreToolUse', toolName: 'Bash' });
  assert.deepEqual(order, ['c', 'a', 'b']);
});

test('条件不命中的 Hook 完全不执行 handler', () => {
  let called = false;
  const registry = new HookRegistry();
  registry.register(
    hook(
      'PreToolUse',
      'mcp-only',
      () => {
        called = true;
        return { kind: 'Allow' };
      },
      'Tool(mcp__*)',
    ),
  );
  executeHookChain(selectorOf(registry), 'PreToolUse', { event: 'PreToolUse', toolName: 'Bash' });
  assert.equal(called, false, '条件不匹配时不得派生/执行 Hook');
});

test('不同事件互不干扰', () => {
  const registry = new HookRegistry();
  registry.register(hook('PreToolUse', 'pre', () => ({ kind: 'Block', reason: 'pre 拦下' })));
  registry.register(hook('PostToolUse', 'post', () => ({ kind: 'Allow' })));

  const pre = executeHookChain(selectorOf(registry), 'PreToolUse', {
    event: 'PreToolUse',
    toolName: 'Bash',
  });
  const post = executeHookChain(selectorOf(registry), 'PostToolUse', {
    event: 'PostToolUse',
    toolName: 'Bash',
    toolSucceeded: true,
  });
  assert.equal(pre.blocked, true);
  assert.equal(post.blocked, false);
});

test('PostToolUse 能观测到调用是否成功', () => {
  const registry = new HookRegistry();
  let observed: boolean | undefined;
  registry.register(
    hook('PostToolUse', 'observe', (invocation) => {
      observed = invocation.toolSucceeded;
      return { kind: 'Allow' };
    }),
  );
  executeHookChain(selectorOf(registry), 'PostToolUse', {
    event: 'PostToolUse',
    toolName: 'Bash',
    toolSucceeded: false,
  });
  assert.equal(observed, false);
});

test('SessionStart 事件可携带启动原因', () => {
  const registry = new HookRegistry();
  let source: string | undefined;
  registry.register(
    hook('SessionStart', 'boot', (invocation) => {
      source = invocation.source;
      return { kind: 'Allow' };
    }),
  );
  executeHookChain(selectorOf(registry), 'SessionStart', {
    event: 'SessionStart',
    source: 'resume',
  });
  assert.equal(source, 'resume');
});
