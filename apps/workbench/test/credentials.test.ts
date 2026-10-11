import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteCredential, loadCredential, storeCredential } from '../src/runtime/credentials';

// SEC-006/007 门面契约：invoke 参数形态、null→undefined 归一、凭据管理器故障不抛进启动路径。
const invokeCalls: { readonly cmd: string; readonly args: Record<string, unknown> }[] = [];
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'credential_load') return args.account === 'github/token' ? 'ghp_stored' : null;
      if (cmd === 'credential_store') return null;
      if (cmd === 'credential_delete') throw new Error('credential manager unavailable');
      throw new Error(`unexpected command: ${cmd}`);
    },
  },
};

test('storeCredential 走原生 credential_store，account 与 secret 原样透传', async () => {
  invokeCalls.length = 0;
  await storeCredential('provider/mimo-token-plan-cn', 'tp-secret');
  assert.deepEqual(invokeCalls, [{ cmd: 'credential_store', args: { account: 'provider/mimo-token-plan-cn', secret: 'tp-secret' } }]);
});

test('loadCredential 把原生 null 归一为 undefined，错误按"没有保存过"处理', async () => {
  assert.equal(await loadCredential('github/token'), 'ghp_stored');
  assert.equal(await loadCredential('provider/unknown'), undefined);
  invokeCalls.length = 0;
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async () => { throw new Error('credential manager unavailable'); },
    },
  };
  assert.equal(await loadCredential('github/token'), undefined);
});

test('deleteCredential 失败不抛出（本就不存在时视为成功）', async () => {
  await deleteCredential('github/token');
});
