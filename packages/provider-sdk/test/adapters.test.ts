import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnthropicMessages,
  LocalOpenAICompatible,
  type ChatRequest,
} from '../src/index.js';

const request: ChatRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'system instruction' },
    { role: 'user', content: 'hello' },
  ],
};

test('本地 OpenAI 兼容端点对路由层明确暴露 local 与低成本标签', () => {
  const driver = new LocalOpenAICompatible('http://127.0.0.1:11434', {
    contextWindow: 16_384,
    supportsTools: true,
  });
  assert.equal(driver.id(), 'local');
  assert.deepEqual(driver.capabilities(), {
    contextWindow: 16_384,
    supportsTools: true,
    supportsVision: false,
    isLocal: true,
    costTier: 'low',
  });
});

test('Anthropic adapter 将 system 与 messages 正规化并读取 content_block_delta', async () => {
  const originalFetch = globalThis.fetch;
  let receivedBody = '';
  globalThis.fetch = (async (_url, init) => {
    receivedBody = String(init?.body ?? '');
    return new Response([
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"text":"hello "}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"world"}}\n\n',
    ].join(''), { status: 200 });
  }) as typeof fetch;
  try {
    const output: string[] = [];
    for await (const chunk of new AnthropicMessages({ baseUrl: 'https://example.invalid' }).chat(request, 'secret')) {
      output.push(chunk);
    }
    assert.deepEqual(output, ['hello ', 'world']);
    assert.deepEqual(JSON.parse(receivedBody), {
      model: 'test-model',
      max_tokens: 4096,
      stream: true,
      system: 'system instruction',
      messages: [{ role: 'user', content: 'hello' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
