import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentTurn } from '../src/runtime/agent-tool-loop';
import type { DirectProviderClient, DirectProviderMessage, DirectProviderToolCall } from '../src/runtime/direct-provider-client';

/** 假客户端：按脚本顺序给出每一轮的模型响应，并记录收到的历史。 */
function fakeClient(responses: readonly { readonly text: string; readonly toolCalls: readonly DirectProviderToolCall[] }[]): DirectProviderClient & { readonly seen: readonly (readonly DirectProviderMessage[])[] } {
  const seen: (readonly DirectProviderMessage[])[] = [];
  let round = 0;
  const client = {
    seen,
    async stream(input: { messages: readonly DirectProviderMessage[]; onText(chunk: string): void }): Promise<{ model?: string; toolCalls: readonly DirectProviderToolCall[] }> {
      seen.push(input.messages);
      const scripted = responses[round] ?? responses[responses.length - 1]!;
      round += 1;
      input.onText(scripted.text);
      return { model: 'test-model', toolCalls: scripted.toolCalls };
    },
  };
  return client as unknown as DirectProviderClient & { readonly seen: readonly (readonly DirectProviderMessage[])[] };
}

const readCall: DirectProviderToolCall = { id: 'call-1', name: 'workspace_read_file', arguments: '{"path":"src/main.rs"}' };
const baseMessages: readonly DirectProviderMessage[] = [{ role: 'user', content: '看一下 main.rs' }];

test('模型不要工具时只跑一轮，文本原样返回', async () => {
  const client = fakeClient([{ text: '这是文件内容。', toolCalls: [] }]);
  const result = await runAgentTurn({ client, providerId: 'p', messages: baseMessages, tools: [], execute: async () => '不该被调用', onText: () => undefined });
  assert.equal(result.rounds, 1);
  assert.equal(result.executedCalls, 0);
  assert.equal(result.stoppedByRoundLimit, false);
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: '这是文件内容。' });
});

test('模型要工具时执行并把结果以 tool 角色回填，再进入下一轮', async () => {
  const client = fakeClient([
    { text: '我先读一下。', toolCalls: [readCall] },
    { text: '读完了：文件内容。', toolCalls: [] },
  ]);
  const executed: readonly { readonly name: string; readonly args: string }[] = [];
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async (name, args) => { executed.push({ name, args }); return 'fn main() {}'; },
    onText: () => undefined,
  });
  assert.deepEqual(executed, [{ name: 'workspace_read_file', args: '{"path":"src/main.rs"}' }]);
  assert.equal(result.executedCalls, 1);
  assert.equal(result.rounds, 2);
  // 历史必须完整保留 assistant 的调用声明，否则模型第二轮不知道自己做过什么。
  assert.deepEqual(result.messages.slice(1), [
    { role: 'assistant', content: '我先读一下。', toolCalls: [readCall] },
    { role: 'tool', content: 'fn main() {}', toolCallId: 'call-1' },
    { role: 'assistant', content: '读完了：文件内容。' },
  ]);
  // 第二轮必须看到工具结果，否则闭环根本没接上。
  assert.equal(client.seen[1]?.some((message) => message.role === 'tool' && message.toolCallId === 'call-1'), true);
});

test('模型一句话没说就发起调用时，assistant 消息允许没有正文', async () => {
  const client = fakeClient([{ text: '', toolCalls: [readCall] }, { text: '完成', toolCalls: [] }]);
  const result = await runAgentTurn({ client, providerId: 'p', messages: baseMessages, tools: [], execute: async () => 'ok', onText: () => undefined });
  const assistant = result.messages.at(1);
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.content, '');
  assert.ok(assistant?.toolCalls);
});

test('达到轮次上限时如实标记，而不是假装已经回答完', async () => {
  const client = fakeClient([{ text: '', toolCalls: [readCall] }]);
  const result = await runAgentTurn({ client, providerId: 'p', messages: baseMessages, tools: [], execute: async () => '结果', onText: () => undefined, maxRounds: 3 });
  assert.equal(result.rounds, 3);
  assert.equal(result.executedCalls, 3);
  assert.equal(result.stoppedByRoundLimit, true);
});

test('不会修改传入的历史数组', async () => {
  const history: DirectProviderMessage[] = [{ role: 'user', content: '问题' }];
  const client = fakeClient([{ text: '答', toolCalls: [] }]);
  await runAgentTurn({ client, providerId: 'p', messages: history, tools: [], execute: async () => 'x', onText: () => undefined });
  assert.deepEqual(history, [{ role: 'user', content: '问题' }]);
});

// ---------------------------------------------------------------------------
// 回合中断：模型请求失败**不能**让已发生的工具执行痕迹消失。
//
// 失败注入确认过的原始行为：第 1 轮返回工具调用 → 工具成功执行 → 第 2 轮模型请求失败
// → 整个回合抛错，调用方拿不到任何部分结果。界面随后删掉流式消息，而工具活动正挂在
// 它上面 —— 结果是文件已经改了，聊天里的操作记录却消失了。
// ---------------------------------------------------------------------------

/** 假客户端：前 `succeedRounds` 轮正常，之后抛出给定错误。 */
function failingClient(
  responses: readonly { readonly text: string; readonly toolCalls: readonly DirectProviderToolCall[] }[],
  failFromRound: number,
  error: unknown,
): DirectProviderClient {
  let round = 0;
  return {
    async stream(input: { messages: readonly DirectProviderMessage[]; onText(chunk: string): void }) {
      round += 1;
      if (round >= failFromRound) throw error;
      const scripted = responses[round - 1] ?? { text: '', toolCalls: [] };
      input.onText(scripted.text);
      return { model: 'test-model', toolCalls: scripted.toolCalls };
    },
  } as unknown as DirectProviderClient;
}

test('第二轮模型失败时不抛异常而是返回部分结果', async () => {
  const client = failingClient([{ text: '我先改一下。', toolCalls: [readCall] }], 2, new Error('provider-sse-error: 连接被重置'));
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => '已写入',
    onText: () => undefined,
  });
  // 抛异常会让调用方丢掉整回合的痕迹；这里必须正常返回。
  assert.equal(result.executedCalls, 1);
  assert.equal(result.failure?.round, 2);
  assert.equal(result.stoppedByRoundLimit, false);
});

test('失败时保留已执行工具的历史与回填结果', async () => {
  const client = failingClient([{ text: '我先改一下。', toolCalls: [readCall] }], 2, new Error('boom'));
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => '文件已更新',
    onText: () => undefined,
  });
  // 历史里必须同时留下"我调用过什么"和"结果是什么"，否则排查失去依据。
  assert.deepEqual(result.messages.slice(1), [
    { role: 'assistant', content: '我先改一下。', toolCalls: [readCall] },
    { role: 'tool', content: '文件已更新', toolCallId: 'call-1' },
  ]);
});

test('失败时原始错误原样带出以便上层翻译', async () => {
  const cause = new Error('provider-sse-error: 上游 502');
  const client = failingClient([{ text: '', toolCalls: [readCall] }], 2, cause);
  const result = await runAgentTurn({ client, providerId: 'p', messages: baseMessages, tools: [], execute: async () => 'ok', onText: () => undefined });
  assert.equal(result.failure?.error, cause);
});

test('首轮就失败时没有执行任何工具', async () => {
  const client = failingClient([], 1, new Error('第一轮就挂了'));
  const result = await runAgentTurn({ client, providerId: 'p', messages: baseMessages, tools: [], execute: async () => '不该被调用', onText: () => undefined });
  assert.equal(result.executedCalls, 0);
  assert.equal(result.failure?.round, 1);
  assert.deepEqual(result.messages, baseMessages);
});

test('execute抛出时同样不丢已完成的执行痕迹', async () => {
  // execute 的契约是"失败返回描述而不是抛出"。真抛了说明契约被违反，
  // 但已经执行过的调用仍然算数，不能把整回合的痕迹丢掉。
  const twoCalls: readonly DirectProviderToolCall[] = [
    { id: 'call-1', name: 'workspace_read_file', arguments: '{}' },
    { id: 'call-2', name: 'workspace_write_file', arguments: '{}' },
  ];
  const client = failingClient([{ text: '开始', toolCalls: twoCalls }], 9, new Error('unused'));
  let executed = 0;
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => {
      executed += 1;
      if (executed === 2) throw new Error('执行器崩了');
      return '第一个成功了';
    },
    onText: () => undefined,
  });
  // 第一个已经真的执行了 —— 它必须留在历史里。
  assert.equal(result.executedCalls, 1);
  assert.equal(result.failure?.error instanceof Error, true);
  assert.deepEqual(result.messages.at(-1), { role: 'tool', content: '第一个成功了', toolCallId: 'call-1' });
});

test('成功路径不带failure字段', async () => {
  const client = fakeClient([{ text: '完成。', toolCalls: [] }]);
  const result = await runAgentTurn({ client, providerId: 'p', messages: baseMessages, tools: [], execute: async () => '', onText: () => undefined });
  assert.equal(result.failure, undefined);
});

test('中断时仍如实触发onToolResult以留下收据', async () => {
  const client = failingClient([{ text: '', toolCalls: [readCall] }], 2, new Error('boom'));
  const receipts: string[] = [];
  await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => '结果',
    onText: () => undefined,
    onToolResult: (call) => receipts.push(call.id),
  });
  assert.deepEqual(receipts, ['call-1']);
});

// ---------------------------------------------------------------------------
// 工具结果的多模态通道：图片必须与文本一起回填到**同一条** tool 消息上。
// 拆成两条会让上游对不回 call id；塞进文本则会让一次截图吃掉几十万字符的窗口。
// ---------------------------------------------------------------------------

const screenshotCall: DirectProviderToolCall = { id: 'shot-1', name: 'mcp__browser__take_screenshot', arguments: '{}' };

test('execute返回图片时工具消息带上images', async () => {
  const client = fakeClient([
    { text: '我看一眼页面。', toolCalls: [screenshotCall] },
    { text: '看到了。', toolCalls: [] },
  ]);
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => ({ text: '已捕获截图', images: [{ mediaType: 'image/png', base64Data: 'AAAA' }] }),
    onText: () => undefined,
  });
  const toolMessage = result.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage, '应有 tool 消息');
  assert.equal(toolMessage.content, '已捕获截图');
  assert.deepEqual(toolMessage.images, [{ mediaType: 'image/png', base64Data: 'AAAA' }]);
  assert.equal(toolMessage.toolCallId, 'shot-1');
});

test('execute返回字符串时工具消息不带images', async () => {
  const client = fakeClient([
    { text: '读一下。', toolCalls: [readCall] },
    { text: '读完了。', toolCalls: [] },
  ]);
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => '文件内容',
    onText: () => undefined,
  });
  const toolMessage = result.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  assert.equal(toolMessage.images, undefined);
});

test('图片回填后第二轮请求能看到它', async () => {
  // 只有真的进了下一轮请求，模型才可能"看见"图。
  const client = fakeClient([
    { text: '先截图。', toolCalls: [screenshotCall] },
    { text: '看到了。', toolCalls: [] },
  ]);
  await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => ({ text: '已捕获截图', images: [{ mediaType: 'image/png', base64Data: 'BBBB' }] }),
    onText: () => undefined,
  });
  const secondRequest = client.seen[1] ?? [];
  const toolMessage = secondRequest.find((message) => message.role === 'tool');
  assert.deepEqual(toolMessage?.images, [{ mediaType: 'image/png', base64Data: 'BBBB' }]);
});

test('空images数组不产生images字段', async () => {
  const client = fakeClient([
    { text: '读一下。', toolCalls: [readCall] },
    { text: '读完了。', toolCalls: [] },
  ]);
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => ({ text: '内容', images: [] }),
    onText: () => undefined,
  });
  assert.equal(result.messages.find((message) => message.role === 'tool')?.images, undefined);
});

test('带图片的中断回合仍保留图片收据', async () => {
  const client = failingClient([{ text: '截图。', toolCalls: [screenshotCall] }], 2, new Error('boom'));
  const result = await runAgentTurn({
    client,
    providerId: 'p',
    messages: baseMessages,
    tools: [],
    execute: async () => ({ text: '已捕获截图', images: [{ mediaType: 'image/png', base64Data: 'CCCC' }] }),
    onText: () => undefined,
  });
  assert.equal(result.failure?.round, 2);
  assert.deepEqual(result.messages.find((message) => message.role === 'tool')?.images, [{ mediaType: 'image/png', base64Data: 'CCCC' }]);
});
