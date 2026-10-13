// 一个文件=一种作用：MCP Apps 宿主侧纯函数的验收测试（信封形状 + 消息门集成）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { gateMcpAppMessage } from '@awo/protocol';
import { toolCallResultMessage } from '../src/components/workspace/McpAppHost';

test('工具结果信封：固定类型与载荷形状，供 iframe 应用按白名单回读', () => {
  const message = toolCallResultMessage('call-1', true, { content: 'ok' });
  assert.deepEqual(message, { type: 'toolCallResult', payload: { toolCallId: 'call-1', ok: true, result: { content: 'ok' } } });
});

test('宿主消息流集成：应用请求 → 门校验 → 结果信封可被应用侧识别', () => {
  const admission = { admittedToolNames: ['read_note'] };
  // 应用发出的请求先过消息门（二次准入校验）。
  const request = { type: 'toolCallRequest', payload: { toolCallId: 'call-1', toolName: 'read_note', arguments: { id: 7 } } };
  const gated = gateMcpAppMessage(request, admission);
  assert.equal(gated.ok, true);
  // 执行结果打包成信封发回；应用侧再次过门时该类型不在白名单（结果只走宿主→应用方向）。
  const result = toolCallResultMessage('call-1', true, { content: '笔记内容' });
  assert.equal(result.type, 'toolCallResult');
  assert.equal(result.payload.ok, true);
  // 未准入工具的请求在门上被拦下，宿主不会执行。
  const forged = { type: 'toolCallRequest', payload: { toolCallId: 'call-2', toolName: 'write_note' } };
  assert.equal(gateMcpAppMessage(forged, admission).ok, false);
});
