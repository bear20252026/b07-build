// 一个文件=一种作用：浏览器能力 MCP 工具面的验收测试。
//
// 断言五件事：① 工具面完整性（13 个工具、三类分组、关键字段与参数 schema）；
// ② 只读 / 副作用标注正确（只读工具不得被标成有副作用，反之亦然）；
// ③ 命名与 protocol 的 mcpToolName / parseMcpToolName round-trip；
// ④ 不可用状态在调用之前就可被外部观察到；⑤ 缺省处理器全拒且错误码稳定、
// 注入真实处理器时能被调用。

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMcpToolName } from '@awo/protocol';

import {
  BROWSER_TOOL_NAMES,
  BROWSER_TOOL_NOT_REGISTERED_CODE,
  BROWSER_TOOL_SERVER_ID,
  BROWSER_TOOL_SPECS,
  BROWSER_TOOL_SURFACE_AVAILABLE,
  BROWSER_TOOL_UNAVAILABLE_CODE,
  BROWSER_TOOL_UNAVAILABLE_TEXT,
  canUseBrowserToolSurface,
  createBrowserToolExecutor,
  createBrowserToolRegistry,
  createBrowserToolSurface,
  createUnavailableBrowserToolHandler,
  findBrowserToolSpec,
  type BrowserToolCall,
  type BrowserToolHandler,
} from '../src/index.js';

/** 只读工具：不改外部世界。 */
const READ_ONLY_TOOLS = [
  BROWSER_TOOL_NAMES.listSessions,
  BROWSER_TOOL_NAMES.snapshot,
  BROWSER_TOOL_NAMES.takeScreenshot,
  BROWSER_TOOL_NAMES.waitFor,
] as const;

/** 有外部副作用的工具：会对外部世界产生影响。 */
const EXTERNAL_TOOLS = [
  BROWSER_TOOL_NAMES.createSession,
  BROWSER_TOOL_NAMES.closeSession,
  BROWSER_TOOL_NAMES.navigate,
  BROWSER_TOOL_NAMES.click,
  BROWSER_TOOL_NAMES.type,
  BROWSER_TOOL_NAMES.fillForm,
  BROWSER_TOOL_NAMES.pressKey,
  BROWSER_TOOL_NAMES.selectOption,
  BROWSER_TOOL_NAMES.tabs,
] as const;

const ALL_TOOL_NAMES = [...READ_ONLY_TOOLS, ...EXTERNAL_TOOLS];

test('工具面完整性：13 个工具、三类分组、命名与关键字段合法', () => {
  assert.equal(BROWSER_TOOL_SPECS.length, 13);
  assert.equal(ALL_TOOL_NAMES.length, 13);

  const categories = new Set(BROWSER_TOOL_SPECS.map((spec) => spec.category));
  assert.deepEqual(
    [...categories].sort(),
    ['navigation-interaction', 'read-only-observation', 'session-lifecycle'],
  );
  assert.equal(BROWSER_TOOL_SPECS.filter((spec) => spec.category === 'session-lifecycle').length, 3);
  assert.equal(BROWSER_TOOL_SPECS.filter((spec) => spec.category === 'read-only-observation').length, 2);
  assert.equal(BROWSER_TOOL_SPECS.filter((spec) => spec.category === 'navigation-interaction').length, 8);

  const names = BROWSER_TOOL_SPECS.map((spec) => spec.name).sort();
  assert.deepEqual(names, [...ALL_TOOL_NAMES].sort());

  for (const spec of BROWSER_TOOL_SPECS) {
    const { descriptor } = spec;
    // 命名遵循 b07 约定：mcp__<server>__<tool>。
    assert.match(spec.name, /^mcp__browser__[a-z_]+$/u);
    assert.equal(descriptor.name, spec.name);
    assert.equal(descriptor.capability, 'browser.control');
    assert.equal(descriptor.destructive, false);
    assert.ok(Number.isSafeInteger(descriptor.resultBudgetChars) && descriptor.resultBudgetChars > 0, `${spec.name} 预算须为正整数`);
    assert.ok(Number.isSafeInteger(descriptor.timeoutMs) && descriptor.timeoutMs > 0, `${spec.name} 超时须为正整数`);
    assert.ok((descriptor.description ?? '').length > 0, `${spec.name} 必须有说明`);
    // 参数 schema：必填参数必须在可选参数之前声明，且名称唯一。
    const paramNames = spec.parameters.map((parameter) => parameter.name);
    assert.equal(new Set(paramNames).size, paramNames.length, `${spec.name} 参数名不得重复`);
    let seenOptional = false;
    for (const parameter of spec.parameters) {
      if (parameter.required) assert.equal(seenOptional, false, `${spec.name} 必填参数不得排在可选参数之后`);
      else seenOptional = true;
      assert.ok(parameter.description.length > 0, `${spec.name}.${parameter.name} 必须有说明`);
    }
  }
});

test('只读 / 副作用标注：只读工具 none+low+可并发，有副作用工具 external+medium+串行', () => {
  for (const name of READ_ONLY_TOOLS) {
    const spec = findBrowserToolSpec(name);
    assert.ok(spec, `缺少工具 ${name}`);
    assert.equal(spec.descriptor.readOnly, true, `${name} 应为只读`);
    assert.equal(spec.descriptor.sideEffectScope, 'none', `${name} 作用域应为 none`);
    assert.equal(spec.descriptor.defaultRisk, 'low', `${name} 风险应为 low`);
    assert.equal(spec.descriptor.concurrentSafe, true, `${name} 只读应可并发`);
  }

  for (const name of EXTERNAL_TOOLS) {
    const spec = findBrowserToolSpec(name);
    assert.ok(spec, `缺少工具 ${name}`);
    assert.equal(spec.descriptor.readOnly, false, `${name} 不得标为只读`);
    assert.equal(spec.descriptor.sideEffectScope, 'external', `${name} 作用域应为 external`);
    assert.equal(spec.descriptor.defaultRisk, 'medium', `${name} 风险应为 medium`);
    assert.equal(spec.descriptor.concurrentSafe, false, `${name} 有副作用应串行`);
  }
});

test('命名与 protocol round-trip：每个工具名都能反向解析回 server / tool', () => {
  for (const spec of BROWSER_TOOL_SPECS) {
    const parsed = parseMcpToolName(spec.name);
    assert.ok(parsed, `${spec.name} 应可解析`);
    assert.equal(parsed.serverId, BROWSER_TOOL_SERVER_ID);
    assert.equal(parsed.toolName, spec.name.slice(`mcp__${BROWSER_TOOL_SERVER_ID}__`.length));
  }
});

test('注册表与不可用状态：可被列举，且不可用在调用前即可观察', () => {
  const registry = createBrowserToolRegistry();
  for (const spec of BROWSER_TOOL_SPECS) assert.equal(registry.has(spec.name), true, `${spec.name} 应已注册`);
  assert.equal(registry.descriptors().length, 13);
  assert.equal(registry.resolve(BROWSER_TOOL_NAMES.snapshot)?.readOnly, true);

  const surface = createBrowserToolSurface();
  assert.equal(surface.available, false);
  assert.equal(surface.unavailableCode, BROWSER_TOOL_UNAVAILABLE_CODE);
  assert.equal(surface.unavailableReason, BROWSER_TOOL_UNAVAILABLE_TEXT);
  assert.equal(surface.specs.length, 13);

  // 谓词是「不可用」的单一事实源，且与工具面常量一致。
  assert.equal(canUseBrowserToolSurface(), false);
  assert.equal(BROWSER_TOOL_SURFACE_AVAILABLE, false);
});

test('缺省处理器：任何工具调用都全拒，错误码稳定、原因可读', async () => {
  const executor = createBrowserToolExecutor();
  const handler = createUnavailableBrowserToolHandler();

  for (const name of ALL_TOOL_NAMES) {
    const call: BrowserToolCall = { toolName: name, arguments: { sessionId: 'session:test' } };
    const result = await executor.execute(call);
    assert.equal(result.isError, true, `${name} 缺省必须失败`);
    assert.equal(result.errorCode, BROWSER_TOOL_UNAVAILABLE_CODE, `${name} 错误码须稳定`);
    assert.equal(result.content.length, 1);
    assert.match(result.content[0]?.text ?? '', /unavailable/u, `${name} 原因须可读`);
    // 直接调用缺省处理器同样全拒（无静默成功路径）。
    assert.equal((await handler.call(call)).isError, true);
  }
});

test('执行器：未登记工具在执行前即失败，绝不漏给处理器', async () => {
  let handlerInvocations = 0;
  const spyHandler: BrowserToolHandler = {
    async call() {
      handlerInvocations += 1;
      return { content: [{ type: 'text', text: 'should-not-happen' }], isError: false };
    },
  };
  const executor = createBrowserToolExecutor({ handler: spyHandler });
  const result = await executor.execute({ toolName: 'mcp__browser__not_a_tool' });

  assert.equal(result.isError, true);
  assert.equal(result.errorCode, BROWSER_TOOL_NOT_REGISTERED_CODE);
  assert.equal(handlerInvocations, 0, '未登记工具不得进入处理器');
});

test('可注入缝：注入真实处理器时能被调用并回传其结果', async () => {
  const received: string[] = [];
  const realHandler: BrowserToolHandler = {
    async call(call) {
      received.push(call.toolName);
      return { content: [{ type: 'text', text: '页面标题：示例' }], isError: false };
    },
  };
  const executor = createBrowserToolExecutor({ handler: realHandler });
  const result = await executor.execute({ toolName: BROWSER_TOOL_NAMES.snapshot, arguments: { sessionId: 'session:test' } });

  assert.deepEqual(received, [BROWSER_TOOL_NAMES.snapshot]);
  assert.equal(result.isError, false);
  assert.equal(result.content[0]?.text, '页面标题：示例');
});
