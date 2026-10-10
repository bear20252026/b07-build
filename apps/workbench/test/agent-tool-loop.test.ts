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
