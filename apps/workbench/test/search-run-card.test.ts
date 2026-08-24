import assert from 'node:assert/strict';
import test from 'node:test';
import { isSearchRunKind, searchRunLabel, searchRunMode, searchRunStatus } from '../src/runtime/search-run-card';

test('搜索运行卡为各活动映射现有发送后端而不创建新的搜索路径', () => {
  assert.equal(searchRunMode('web-search', '已检索'), 'web-search');
  assert.equal(searchRunMode('hybrid-search', '已执行'), 'hybrid');
  assert.equal(searchRunMode('searxng', '已执行'), 'searxng-local');
  assert.equal(searchRunMode('research', '已执行中文近 30 天研究'), 'last30days-cn');
  assert.equal(searchRunMode('research', '已执行近 30 天研究'), 'last30days');
});

test('搜索运行卡独立显示失败，但不将其标记为 Provider 失败', () => {
  assert.equal(searchRunStatus('本地 SearXNG 在嵌入式 Python 冷启动期间未完成健康检查，本轮将继续以普通聊天发送。'), 'failed');
  assert.equal(searchRunStatus('已获取 3 个来源，原始正文仅传递给本轮模型。'), 'succeeded');
  assert.equal(searchRunLabel('searxng', '任意'), '本地 SearXNG · Loopback');
  assert.equal(isSearchRunKind('attachment'), false);
});
