// packages/agent-runtime/test/egress-policy.test.ts
// 一个文件=一种作用：出网公网边界的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublicEgressUrl,
  evaluatePublicEgressHost,
  evaluatePublicEgressUrl,
  getPublicEgressIpBlockReason,
  isEgressIpLiteral,
  isLocalEgressHostname,
  normalizeEgressHostname,
  PublicEgressError,
} from '../src/network/egress-policy';

test('主机名归一化去方括号、去末尾点、转小写', () => {
  assert.equal(normalizeEgressHostname('  EXAMPLE.com  '), 'example.com');
  assert.equal(normalizeEgressHostname('[::1]'), '::1');
  assert.equal(normalizeEgressHostname('127.0.0.1.'), '127.0.0.1');
  assert.equal(normalizeEgressHostname('localhost.'), 'localhost');
});

test('本机主机名判定覆盖任意子域', () => {
  for (const hostname of ['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'a.b.localhost']) {
    assert.equal(isLocalEgressHostname(hostname), true, `应当算本机：${hostname}`);
  }
  for (const hostname of ['example.com', 'localhost.example.com', 'notlocalhost']) {
    assert.equal(isLocalEgressHostname(hostname), false, `不应算本机：${hostname}`);
  }
});

test('IP 字面量识别覆盖 v4 与 v6', () => {
  assert.equal(isEgressIpLiteral('127.0.0.1'), true);
  assert.equal(isEgressIpLiteral('::1'), true);
  assert.equal(isEgressIpLiteral('::ffff:127.0.0.1'), true);
  assert.equal(isEgressIpLiteral('example.com'), false);
  assert.equal(isEgressIpLiteral('127.0.0.1.example.com'), false);
});

test('私网、回环、链路本地与保留段都被阻断', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '127.255.255.254',
    '100.64.1.1',
    '169.254.1.1',
    '172.16.5.5',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.1',
    '198.18.0.5',
    '198.19.255.255',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b:1::1',
    '100::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
  ]) {
    const reason = getPublicEgressIpBlockReason(address);
    assert.ok(reason, `应当被阻断：${address}`);
    assert.notEqual(reason?.version, 0, `应当是合法 IP：${address}`);
  }
});

test('IPv4-mapped 与 NAT64/DNS64 承载的私网地址同样被阻断', () => {
  for (const address of [
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '64:ff9b::c0a8:101',
  ]) {
    const decision = evaluatePublicEgressHost(address);
    assert.equal(decision.allowed, false, `应当被阻断：${address}`);
  }
});

test('公网 IP 与普通域名被放行', () => {
  for (const hostname of [
    'example.com',
    'docs.example.co.uk',
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ]) {
    const decision = evaluatePublicEgressHost(hostname);
    assert.equal(decision.allowed, true, `应当放行：${hostname}`);
  }
});

test('URL 判定与断言走同一套策略', () => {
  assert.equal(evaluatePublicEgressUrl(new URL('https://example.com/a')).allowed, true);
  assert.equal(evaluatePublicEgressUrl(new URL('https://127.0.0.1:8443/')).allowed, false);
  assert.equal(evaluatePublicEgressUrl(new URL('https://[::1]/')).allowed, false);
  assert.equal(evaluatePublicEgressUrl(new URL('https://foo.localhost/')).allowed, false);

  assert.throws(() => assertPublicEgressUrl(new URL('https://127.0.0.1./')), PublicEgressError);
  assert.doesNotThrow(() => assertPublicEgressUrl(new URL('https://example.com/')));
});

test('空主机名被拒绝而不是当作域名放行', () => {
  const decision = evaluatePublicEgressHost('   ');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'empty hostname');
});

test('非 IP 字面量返回 version 0 而不是被当作公网', () => {
  const reason = getPublicEgressIpBlockReason('example.com');
  assert.equal(reason?.version, 0);
  assert.equal(reason?.reason, 'not an IP address');
});
