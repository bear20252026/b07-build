import assert from 'node:assert/strict';
import test from 'node:test';
import { searxngErrorText } from '../src/runtime/use-direct-conversations.js';

test('SearXNG 启动和 loopback 失败仅显示检索活动提示，不混同为 Provider 或 Gateway 失败', () => {
  assert.match(searxngErrorText(new Error('searxng-python-exited')), /内嵌 Python/);
  assert.match(searxngErrorText(new Error('searxng-request-failed')), /原始问题直接发送给当前第三方模型/);
  assert.doesNotMatch(searxngErrorText(new Error('searxng-request-rejected')), /Gateway|API key/i);
});
