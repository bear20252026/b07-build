// 一个文件=一种作用：Explore 只读工具集与 description 排序的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPLORE_ALLOWED_TOOLS,
  EXPLORE_EMBEDDED_SEARCH_ALLOWED_TOOLS,
  buildExploreAllowedTools,
  formatExploreAllowedToolsForAgentDescription,
} from '../src/index.js';

test('Explore 白名单刻意不含任何文件写工具', () => {
  const allowed: readonly string[] = EXPLORE_ALLOWED_TOOLS;
  for (const writeTool of ['Write', 'Edit', 'ApplyPatch', 'MultiEdit']) {
    assert.equal(allowed.includes(writeTool), false, `${writeTool} 不得出现在只读白名单`);
  }
  assert.deepEqual(buildExploreAllowedTools(), [...EXPLORE_ALLOWED_TOOLS]);
});

test('embedded search 变体去掉 Glob/Grep，交由 Bash 的 find/grep 接管', () => {
  assert.deepEqual(buildExploreAllowedTools({ embeddedSearchEnabled: true }), [
    'Bash',
    'Read',
    'WebFetch',
    'WebSearch',
    'TodoWrite',
  ]);
  const embedded: readonly string[] = EXPLORE_EMBEDDED_SEARCH_ALLOWED_TOOLS;
  assert.equal(embedded.includes('Glob'), false);
  assert.equal(embedded.includes('Grep'), false);
});

test('description 工具清单按固定优先级排序', () => {
  assert.equal(
    formatExploreAllowedToolsForAgentDescription(),
    'Glob, Grep, Read, Bash, WebFetch, WebSearch, TodoWrite',
  );
  // embedded 分支去掉 Glob/Grep 后，剩余工具仍按同一优先级排列。
  assert.equal(
    formatExploreAllowedToolsForAgentDescription({ embeddedSearchEnabled: true }),
    'Read, Bash, WebFetch, WebSearch, TodoWrite',
  );
});
