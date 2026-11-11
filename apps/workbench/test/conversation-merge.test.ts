import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeLoadedConversations, shouldInjectBrowserTools, type DirectConversation } from '../src/runtime/use-direct-conversations.js';

// ---------------------------------------------------------------------------
// 启动时原生账本加载是**异步**的：返回时用户可能已经建了新会话或发了消息。
// 直接 `setConversations(stored)` 会用旧快照覆盖这些新状态 —— 那是数据丢失。
// 本文件的每条用例都对应一种"加载期间用户动过手"的情形。
// ---------------------------------------------------------------------------

function conversation(id: string, updatedAt: number, title = id): DirectConversation {
  return {
    schemaVersion: 1,
    id,
    title,
    selection: { providerId: 'p' },
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

test('账本为空时保留内存中的全部会话', () => {
  const current = [conversation('a', 10)];
  assert.deepEqual(mergeLoadedConversations(current, []), current);
});

test('内存为空时全部采用账本内容', () => {
  const stored = [conversation('a', 10), conversation('b', 20)];
  // 合并结果统一按 updatedAt 倒序（账本自身的顺序不保证，故不沿用它的顺序）。
  assert.deepEqual(mergeLoadedConversations([], stored).map((item) => item.id), ['b', 'a']);
});

test('同一会话取更新时间更晚的一方', () => {
  const current = [conversation('a', 50, '内存里改过')];
  const stored = [conversation('a', 10, '账本里的旧标题')];
  const merged = mergeLoadedConversations(current, stored);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.title, '内存里改过');
});

test('账本更新时采用账本一方', () => {
  const current = [conversation('a', 10, '内存旧')];
  const stored = [conversation('a', 90, '账本新')];
  const merged = mergeLoadedConversations(current, stored);
  assert.equal(merged[0]!.title, '账本新');
});

test('加载期间新建的会话不被旧快照抹掉', () => {
  // 这是本项缺陷的核心场景：账本里有 a，用户在加载期间建了 b。
  const current = [conversation('b', 100)];
  const stored = [conversation('a', 10)];
  const merged = mergeLoadedConversations(current, stored);
  assert.deepEqual(merged.map((item) => item.id).sort(), ['a', 'b']);
});

test('更新时间相同时保留内存那一份', () => {
  // 相等说明两边是同一版本；内存那份是用户刚操作过的，账本可能是稍早读到的。
  const current = [conversation('a', 30, '内存')];
  const stored = [conversation('a', 30, '账本')];
  assert.equal(mergeLoadedConversations(current, stored)[0]!.title, '内存');
});

test('结果按更新时间倒序', () => {
  const merged = mergeLoadedConversations([conversation('a', 10)], [conversation('b', 30), conversation('c', 20)]);
  assert.deepEqual(merged.map((item) => item.id), ['b', 'c', 'a']);
});

test('结果仍然受会话条数上限约束', () => {
  const many = Array.from({ length: 40 }, (_, index) => conversation(`c${index}`, index + 1));
  const merged = mergeLoadedConversations(many, []);
  assert.equal(merged.length, 32);
  // 裁掉的是最旧的。
  assert.equal(merged[0]!.id, 'c39');
});

// ---------------------------------------------------------------------------
// 浏览器工具注入判定：同时决定"告诉模型有哪些工具"与"调用路由到哪"，
// 两边必须同一个答案；也是"依赖数组漏项导致功能静默失效"的落点。
// ---------------------------------------------------------------------------

test('未请求时不注入浏览器工具', () => {
  assert.equal(shouldInjectBrowserTools(false, { enabled: true, debuggerPort: 9222, sessionCount: 0 }), false);
});

test('请求了但后端未启用时不注入', () => {
  assert.equal(shouldInjectBrowserTools(true, { enabled: false, debuggerPort: 9222, sessionCount: 0 }), false);
});

test('状态不可读时不注入（fail-closed）', () => {
  assert.equal(shouldInjectBrowserTools(true, undefined), false);
});

test('请求了且后端已启用时才注入', () => {
  assert.equal(shouldInjectBrowserTools(true, { enabled: true, debuggerPort: 9222, sessionCount: 3 }), true);
});
