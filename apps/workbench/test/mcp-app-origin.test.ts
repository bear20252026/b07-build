// 一个文件=一种作用：MCP App 沙箱来源标识（P2-3）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_APP_SANDBOX_LABEL_PREFIX,
  MCP_APP_SANDBOX_PARTITION_PREFIX,
  deriveMcpAppSandboxLabel,
  deriveMcpAppSandboxPartition,
  findOrphanMcpAppSandboxPartitions,
  isMcpAppSandboxPartition,
} from '../src/runtime/zcode/mcp-app-origin';

test('派生：FNV-1a 64 命中公开测试向量，标签与 partition 名形状固定', () => {
  // 向量取自 FNV 参考实现，独立于本仓库实现，防止「自证」。
  assert.equal(deriveMcpAppSandboxLabel(''), `${MCP_APP_SANDBOX_LABEL_PREFIX}cbf29ce484222325`);
  assert.equal(deriveMcpAppSandboxLabel('a'), `${MCP_APP_SANDBOX_LABEL_PREFIX}af63dc4c8601ec8c`);
  assert.equal(deriveMcpAppSandboxLabel('abc'), `${MCP_APP_SANDBOX_LABEL_PREFIX}e71fa2190541574b`);
  assert.equal(deriveMcpAppSandboxLabel('foobar'), `${MCP_APP_SANDBOX_LABEL_PREFIX}85944171f73967e8`);
  assert.equal(deriveMcpAppSandboxPartition('abc'), `${MCP_APP_SANDBOX_PARTITION_PREFIX}e71fa2190541574b`);
});

test('稳定性与隔离性：同 appIdentity 恒定、异 appIdentity 不同，标签是合法 DNS 标签', () => {
  const first = deriveMcpAppSandboxLabel('workspace:/w#acct:u1');
  const second = deriveMcpAppSandboxLabel('workspace:/w#acct:u1');
  const other = deriveMcpAppSandboxLabel('workspace:/w#acct:u2');
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^plugin-sandbox-v2-[a-f0-9]{16}$/);
  assert.ok(first.length <= 63);
});

test('校验：只认本方案 partition，拒绝缺前缀/长度不符/大写十六进制/他方 partition', () => {
  assert.ok(isMcpAppSandboxPartition(deriveMcpAppSandboxPartition('abc')));
  assert.ok(!isMcpAppSandboxPartition('plugin-sandbox-v2-e71fa2190541574b'));
  assert.ok(!isMcpAppSandboxPartition(`${MCP_APP_SANDBOX_PARTITION_PREFIX}e71fa2190541574`));
  assert.ok(!isMcpAppSandboxPartition(`${MCP_APP_SANDBOX_PARTITION_PREFIX}E71FA2190541574B`));
  assert.ok(!isMcpAppSandboxPartition('persist:zcode-embedded-browser'));
});

test('孤儿识别：只清理无活跃 app 的本方案 partition，去重且不误伤他方', () => {
  const live = deriveMcpAppSandboxPartition('app-live');
  const orphan = deriveMcpAppSandboxPartition('app-gone');
  const result = findOrphanMcpAppSandboxPartitions(
    [live, orphan, 'persist:zcode-embedded-browser', orphan],
    ['app-live'],
  );
  assert.deepEqual(result, [orphan]);
  assert.deepEqual(findOrphanMcpAppSandboxPartitions([live], ['app-live']), []);
});
