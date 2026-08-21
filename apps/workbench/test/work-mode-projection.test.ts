import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkModeAuditProjection } from '../src/components/workspace/work-mode-projection.js';

test('工作方式审计只投影显式 Profile、权限模式和脱敏连接数量', () => {
  const projection = createWorkModeAuditProjection({ profileId: 'plan', authorityMode: 'review', connectedProviderCount: 2 });
  assert.equal(projection.profileId, 'plan');
  assert.equal(projection.authorityMode, 'review');
  assert.match(projection.connectionSummary, /2 个/);
  assert.match(projection.boundarySummary, /不等于自动调用/);
});

test('未连接模型时保留明确用户配置提示，不伪造可调用连接', () => {
  const projection = createWorkModeAuditProjection({ profileId: 'reader', authorityMode: 'plan', connectedProviderCount: 0 });
  assert.match(projection.connectionSummary, /尚未连接模型/);
});
