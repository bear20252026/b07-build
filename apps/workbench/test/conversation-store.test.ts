import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationStore } from '../src/runtime/conversation-store';
import type { DirectConversation } from '../src/runtime/use-direct-conversations';

// ---------------------------------------------------------------------------
// Tauri 边界替身：`@tauri-apps/api/core` 的 invoke 会转发到
// `window.__TAURI_INTERNALS__.invoke`（与 workspace-tools.test.ts 同款做法）。
// ---------------------------------------------------------------------------

interface InvokeCall { readonly cmd: string; readonly args: Record<string, unknown>; }

let calls: InvokeCall[] = [];
/** 下一次 `conversation_store_upsert` / `_remove` 是否失败。 */
let failWrites = false;

function installTauriRuntime(): void {
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'conversation_store_load') return [];
        if (cmd === 'conversation_store_upsert' || cmd === 'conversation_store_remove') {
          if (failWrites) throw 'conversation-store-write-failed';
          return null;
        }
        throw `unexpected command: ${cmd}`;
      },
    },
  };
}

function installNonTauriRuntime(): void {
  (globalThis as unknown as { window: unknown }).window = {};
}

function conversation(id: string): DirectConversation {
  return {
    schemaVersion: 1,
    id,
    title: id,
    selection: { providerId: 'p' },
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function reset(): void {
  calls = [];
  failWrites = false;
  conversationStore.__resetForTests();
}

// ---------------------------------------------------------------------------

test('原生写入成功时返回true且没有未保存内容', async () => {
  installTauriRuntime();
  reset();
  assert.equal(await conversationStore.upsert(conversation('a')), true);
  assert.equal(conversationStore.hasUnsaved(), false);
  assert.equal(conversationStore.unsavedCount(), 0);
  assert.equal(conversationStore.available(), true);
});

test('原生写入失败时返回false并立刻可见未保存', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  // 这是本项缺陷的核心：上一版返回 void，调用方不知道失败，也就不会补存到备用存储。
  assert.equal(await conversationStore.upsert(conversation('a')), false);
  assert.equal(conversationStore.hasUnsaved(), true);
  assert.equal(conversationStore.unsavedCount(), 1);
  // 降级后调用方走备用存储。
  assert.equal(conversationStore.available(), false);
});

test('删除失败同样返回false并记录待重试', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  assert.equal(await conversationStore.remove('a'), false);
  assert.equal(conversationStore.unsavedCount(), 1);
});

test('非Tauri运行时写入返回false并记录待重试', async () => {
  installNonTauriRuntime();
  reset();
  assert.equal(await conversationStore.upsert(conversation('a')), false);
  assert.equal(conversationStore.hasUnsaved(), true);
  assert.equal(conversationStore.available(), false);
});

test('重试成功后清空队列并恢复可用', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  await conversationStore.upsert(conversation('a'));
  assert.equal(conversationStore.available(), false);
  // 失败多为暂时性（磁盘忙、数据库被占）：补上之后不该继续把原生判为不可用。
  failWrites = false;
  const result = await conversationStore.flushPending();
  assert.deepEqual(result, { saved: 1, failed: 0 });
  assert.equal(conversationStore.hasUnsaved(), false);
  assert.equal(conversationStore.available(), true);
});

test('重试仍失败时保留队列且保持降级', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  await conversationStore.upsert(conversation('a'));
  const result = await conversationStore.flushPending();
  assert.deepEqual(result, { saved: 0, failed: 1 });
  assert.equal(conversationStore.unsavedCount(), 1);
  assert.equal(conversationStore.available(), false);
});

test('同一会话的多次写入只保留最后一条', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  await conversationStore.upsert(conversation('a'));
  await conversationStore.upsert(conversation('a'));
  await conversationStore.upsert(conversation('a'));
  // 要落盘的是**最终状态**，不是过程。
  assert.equal(conversationStore.unsavedCount(), 1);
});

test('先写后删时队列里留下的是删除', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  await conversationStore.upsert(conversation('a'));
  await conversationStore.remove('a');
  assert.equal(conversationStore.unsavedCount(), 1);
  failWrites = false;
  calls = [];
  await conversationStore.flushPending();
  // 补写时只应发出删除，而不是先把会话写回去再删掉。
  assert.deepEqual(calls.map((call) => call.cmd), ['conversation_store_remove']);
});

test('先删后写时队列里留下的是写入', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  await conversationStore.remove('a');
  await conversationStore.upsert(conversation('a'));
  failWrites = false;
  calls = [];
  await conversationStore.flushPending();
  assert.deepEqual(calls.map((call) => call.cmd), ['conversation_store_upsert']);
});

test('未保存状态变化会通知订阅者', async () => {
  installTauriRuntime();
  reset();
  const seen: number[] = [];
  const unsubscribe = conversationStore.onUnsavedChange((count) => seen.push(count));
  failWrites = true;
  await conversationStore.upsert(conversation('a'));
  failWrites = false;
  await conversationStore.flushPending();
  unsubscribe();
  assert.deepEqual(seen, [1, 0]);
});

test('取消订阅后不再收到通知', async () => {
  installTauriRuntime();
  reset();
  const seen: number[] = [];
  const unsubscribe = conversationStore.onUnsavedChange((count) => seen.push(count));
  unsubscribe();
  failWrites = true;
  await conversationStore.upsert(conversation('a'));
  assert.deepEqual(seen, []);
});

test('非Tauri时重试是空操作', async () => {
  installNonTauriRuntime();
  reset();
  await conversationStore.upsert(conversation('a'));
  calls = [];
  const result = await conversationStore.flushPending();
  assert.deepEqual(result, { saved: 0, failed: 0 });
  assert.deepEqual(calls, []);
});

test('降级后不再尝试原生写入而是直接排队', async () => {
  installTauriRuntime();
  reset();
  failWrites = true;
  await conversationStore.upsert(conversation('a'));
  calls = [];
  // 已降级：不应再对原生发起写入（避免每次保存都白等一次失败）。
  await conversationStore.upsert(conversation('b'));
  assert.deepEqual(calls, []);
  assert.equal(conversationStore.unsavedCount(), 2);
});

test('加载失败也降级但不产生待重试项', async () => {
  installTauriRuntime();
  reset();
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: { invoke: unknown } } }).window.__TAURI_INTERNALS__.invoke = async () => {
    throw 'conversation-store-load-failed';
  };
  assert.deepEqual(await conversationStore.load(), []);
  assert.equal(conversationStore.available(), false);
  // 读失败没有"这份数据"要补存，故不应凭空产生待重试项。
  assert.equal(conversationStore.unsavedCount(), 0);
});
