// 一个文件=一种作用：retention 维度分维夹具的 CI 接入——逐项报告，可单独运行本文件。
//
// 维度定义在 `src/runtime/zcode/fixture/retention-dimension.ts`，与人工验收夹具共用同一份
// 不变式；此处只负责把每条检查映射成一个 node:test 用例（分别报告）并汇总。

import assert from 'node:assert/strict';
import test from 'node:test';
import { RETENTION_DIMENSION, runMcpAppFixtureDimension } from '../src/runtime/zcode/fixture/index';

for (const check of RETENTION_DIMENSION.checks) {
  test(`[retention] ${check.name}`, async () => {
    await check.run();
  });
}

test('[retention] 分维报告：本维度全部检查通过', async () => {
  const report = await runMcpAppFixtureDimension(RETENTION_DIMENSION);
  for (const check of report.checks) {
    console.log(`[${report.id}] ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` :: ${check.detail}` : ''}`);
  }
  assert.equal(report.ok, true, report.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`).join('; '));
});
