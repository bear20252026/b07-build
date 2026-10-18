#!/usr/bin/env node
// 一个零依赖的 MCP stdio 服务器，用于集成测试。
//
// 为什么要一个"真服务器"而不是继续用 loopback 假对象：
// loopback 只验证了「适配器形状对不对」，验证不了「真实进程 + 真实管道 + 逐行帧」
// 这条链路 —— 而那正是 `McpStdioTransport` 在原生侧要做的事。
//
// 只实现三条语义：initialize / tools/list / tools/call。

import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'greet',
    description: '打招呼',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'fail_on_purpose',
    description: '总是失败，用于验证 isError 语义',
    inputSchema: { type: 'object', properties: {} },
  },
];

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return; // 坏帧丢弃：真实服务器也不该因此崩溃
  }
  // 通知没有 id，不回。
  if (request.id === undefined || request.id === null) return;

  const reply = (result) => write({ jsonrpc: '2.0', id: request.id, result });

  switch (request.method) {
    case 'initialize':
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'b07-fixture-server', version: '1.0.0' },
      });
      return;
    case 'tools/list':
      reply({ tools: TOOLS });
      return;
    case 'tools/call': {
      const name = request.params?.name;
      if (name === 'greet') {
        const who = request.params?.arguments?.name ?? '世界';
        reply({ content: [{ type: 'text', text: `你好，${who}` }] });
        return;
      }
      if (name === 'fail_on_purpose') {
        // 业务失败：isError，不是协议错误。
        reply({ content: [{ type: 'text', text: '故意失败' }], isError: true });
        return;
      }
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `未知工具：${name}` } });
      return;
    }
    default:
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } });
  }
});

// 父进程关闭 stdin 时干净退出。
lines.on('close', () => process.exit(0));
