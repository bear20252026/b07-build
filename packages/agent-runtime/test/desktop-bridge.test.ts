import { strict as assert } from 'node:assert';
import test from 'node:test';
import { DesktopBridgeGuard } from '../src/index.js';

test('Desktop Bridge 仅允许已登记 window 的显式只读 command，且永不授予执行权', () => {
  const guard = new DesktopBridgeGuard();
  const manifest = guard.register({ schemaVersion: 1, windowLabel: 'main', allowedCommands: ['runtime.health.read'], canExecute: false });
  assert.equal(manifest.canExecute, false);
  const allowed = guard.decide({ schemaVersion: 1, windowLabel: 'main', command: 'runtime.health.read' });
  assert.deepEqual(allowed, { schemaVersion: 1, windowLabel: 'main', command: 'runtime.health.read', allowed: true, reason: '允许只读 metadata command', canExecute: false });
  assert.equal(guard.decide({ schemaVersion: 1, windowLabel: 'main', command: 'local-models.list' }).allowed, false);
  assert.equal(guard.decide({ schemaVersion: 1, windowLabel: 'main', command: 'extension.start' }).allowed, false);
});

test('Desktop Bridge 拒绝 contract 漂移、未登记窗口与宽泛 capability manifest', () => {
  const guard = new DesktopBridgeGuard();
  assert.throws(() => guard.register({ schemaVersion: 1, windowLabel: 'main', allowedCommands: [] as never[], canExecute: false }));
  assert.throws(() => guard.register({ schemaVersion: 1, windowLabel: 'main', allowedCommands: ['runtime.health.read'], canExecute: true } as unknown as Parameters<typeof guard.register>[0]));
  assert.equal(guard.decide({ schemaVersion: 1, windowLabel: 'missing', command: 'runtime.health.read' }).allowed, false);
  assert.equal(guard.decide({ schemaVersion: 1, windowLabel: 'main', command: 'runtime.health.read', arbitrary: 'nope' }).allowed, false);
});

test('Desktop Bridge manifest list 返回防御性副本', () => {
  const guard = new DesktopBridgeGuard();
  guard.register({ schemaVersion: 1, windowLabel: 'main', allowedCommands: ['runtime.health.read'], canExecute: false });
  const listed = guard.list() as unknown as Array<{ allowedCommands: string[] }>;
  listed[0].allowedCommands.push('local-models.list');
  assert.deepEqual(guard.list()[0].allowedCommands, ['runtime.health.read']);
});
