// 一个文件=一种作用：扩展宿主命令面（Tauri 侧桥）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtensionHostClient, type ExtensionHostClientDeps, type ExtensionHostSnapshot } from '../src/runtime/extension-host-client';

interface RecordedCall {
  readonly command: string;
  readonly args: Record<string, unknown>;
}

const ABSOLUTE_HOST = process.platform === 'win32'
  ? 'C:\\awo\\extension\\bin\\host.exe'
  : '/opt/awo/extension/bin/host';

function fakeDeps(result: unknown = null): { deps: ExtensionHostClientDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    deps: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return result;
      },
    },
  };
}

const snapshot: ExtensionHostSnapshot = {
  protocolVersion: 'awo.extension-host.v1',
  extensionId: 'plugin.alpha',
  revision: 2,
  resourceEnforcement: 'requested_only',
  state: 'spawned',
  startedAtMs: 1,
  updatedAtMs: 2,
  exitCode: null,
  detail: null,
};

test('start：extension_host_start 携带 camelCase 启动规格', async () => {
  const { deps, calls } = fakeDeps(snapshot);
  const started = await new ExtensionHostClient(deps).start({
    extensionId: 'plugin.alpha',
    revision: 2,
    executable: ABSOLUTE_HOST,
    args: ['--transport', 'stdio'],
    budget: { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
  });
  assert.equal(started.state, 'spawned');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'extension_host_start');
  assert.deepEqual(calls[0]?.args, {
    request: {
      extensionId: 'plugin.alpha',
      revision: 2,
      executable: ABSOLUTE_HOST,
      args: ['--transport', 'stdio'],
      budget: { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
    },
  });
});

test('start：args 缺省收敛为空数组，且相对路径在客户端即拒绝', async () => {
  const { deps, calls } = fakeDeps(snapshot);
  const client = new ExtensionHostClient(deps);
  await client.start({
    extensionId: 'plugin.alpha',
    revision: 2,
    executable: ABSOLUTE_HOST,
    budget: { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
  });
  assert.deepEqual((calls[0]?.args.request as { args: unknown }).args, []);

  for (const executable of ['npx', './bin/host', 'host.exe', '/opt/host\ninjected']) {
    await assert.rejects(
      () => client.start({
        extensionId: 'plugin.alpha',
        revision: 2,
        executable,
        budget: { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
      }),
      /extension-host-executable-not-absolute/,
    );
  }
  assert.equal(calls.length, 1, '非法路径不得触达命令面');
});

test('stop 与 status 走对应命令，未运行时返回 null', async () => {
  const { deps, calls } = fakeDeps(null);
  const client = new ExtensionHostClient(deps);
  assert.equal(await client.stop(), null);
  assert.equal(await client.status(), null);
  assert.deepEqual(calls.map((call) => call.command), ['extension_host_stop', 'extension_host_status']);
});

test('stop 与 status 透传原生快照', async () => {
  const { deps } = fakeDeps(snapshot);
  const client = new ExtensionHostClient(deps);
  assert.deepEqual(await client.status(), snapshot);
  assert.deepEqual(await client.stop(), snapshot);
});

test('非 Tauri 运行时且未注入依赖时拒绝调用（浏览器不得直连原生进程面）', async () => {
  const client = new ExtensionHostClient();
  await assert.rejects(() => client.status(), /extension-host-native-unavailable/);
  await assert.rejects(
    () => client.start({
      extensionId: 'plugin.alpha',
      revision: 2,
      executable: ABSOLUTE_HOST,
      budget: { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
    }),
    /extension-host-native-unavailable/,
  );
});

test('start 收到非法响应时显式报错，不返回半成品快照', async () => {
  const { deps } = fakeDeps(undefined);
  const client = new ExtensionHostClient(deps);
  await assert.rejects(
    () => client.start({
      extensionId: 'plugin.alpha',
      revision: 2,
      executable: ABSOLUTE_HOST,
      budget: { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
    }),
    /extension-host-start-invalid-response/,
  );
});
