import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPluginReferenceCatalog, findPluginCatalogEntry } from '../src/catalog.js';

// ---------------------------------------------------------------------------
// 会话内冻结的插件目录：同名冲突必须被标出来，不能靠加载顺序决定胜负。
// ---------------------------------------------------------------------------

function plugin(id: string, enabled = true, mcpServerIds: readonly string[] = []) {
  const [name, marketplace] = id.split('@');
  return { id, name: name ?? id, marketplace: marketplace ?? 'm', enabled, mcpServerIds };
}

test('目录按插件记录建条目', () => {
  const { catalog, invalidPluginIds } = buildPluginReferenceCatalog([
    plugin('alpha@official', true, ['alpha:server']),
  ]);
  assert.deepEqual(invalidPluginIds, []);
  assert.equal(catalog.plugins.length, 1);
  assert.deepEqual(catalog.plugins[0], {
    pluginId: 'alpha@official',
    name: 'alpha',
    marketplace: 'official',
    enabled: true,
    conflictingPluginIds: [],
    mcpServerIds: ['alpha:server'],
  });
});

test('同名且都启用时互相标冲突', () => {
  // b07 的 id 是 name@marketplace：不同市场可以发布同名插件。两个都启用时
  // "用 @alpha" 指代不明。不做 last-write-wins（结果会取决于加载顺序）。
  const { catalog } = buildPluginReferenceCatalog([
    plugin('alpha@official'),
    plugin('alpha@community'),
  ]);
  const official = findPluginCatalogEntry(catalog, 'alpha@official');
  const community = findPluginCatalogEntry(catalog, 'alpha@community');
  assert.deepEqual(official?.conflictingPluginIds, ['alpha@community']);
  assert.deepEqual(community?.conflictingPluginIds, ['alpha@official']);
});

test('未启用的同名插件不参与冲突', () => {
  // 未启用的插件在运行时名字空间里不存在，标冲突只会把能用的那个也废掉。
  const { catalog } = buildPluginReferenceCatalog([
    plugin('alpha@official', true),
    plugin('alpha@community', false),
  ]);
  assert.deepEqual(findPluginCatalogEntry(catalog, 'alpha@official')?.conflictingPluginIds, []);
  assert.deepEqual(findPluginCatalogEntry(catalog, 'alpha@community')?.conflictingPluginIds, []);
});

test('三个同名启用插件互相两两标冲突', () => {
  const { catalog } = buildPluginReferenceCatalog([
    plugin('a@one'),
    plugin('a@two'),
    plugin('a@three'),
  ]);
  assert.deepEqual(findPluginCatalogEntry(catalog, 'a@one')?.conflictingPluginIds, ['a@three', 'a@two']);
  assert.deepEqual(findPluginCatalogEntry(catalog, 'a@two')?.conflictingPluginIds, ['a@one', 'a@three']);
});

test('不同名的插件不冲突', () => {
  const { catalog } = buildPluginReferenceCatalog([plugin('a@one'), plugin('b@one')]);
  assert.deepEqual(findPluginCatalogEntry(catalog, 'a@one')?.conflictingPluginIds, []);
});

test('非法id被挡在目录外并如实报出', () => {
  // 静默丢弃会让"目录里少了一个插件"变成很难注意到的现象。
  const { catalog, invalidPluginIds } = buildPluginReferenceCatalog([
    plugin('ok@m'),
    { id: 'no-at-sign', name: 'x', marketplace: 'm', enabled: true },
    { id: 'a@b@c', name: 'x', marketplace: 'm', enabled: true },
  ]);
  assert.deepEqual(catalog.plugins.map((entry) => entry.pluginId), ['ok@m']);
  assert.deepEqual(invalidPluginIds, ['no-at-sign', 'a@b@c']);
});

test('mcpServerIds已排序且缺省为空', () => {
  const { catalog } = buildPluginReferenceCatalog([
    plugin('a@m', true, ['z', 'a', 'm']),
    plugin('b@m'),
  ]);
  assert.deepEqual(findPluginCatalogEntry(catalog, 'a@m')?.mcpServerIds, ['a', 'm', 'z']);
  assert.deepEqual(findPluginCatalogEntry(catalog, 'b@m')?.mcpServerIds, []);
});

test('未启用的插件仍进目录（用于报disabled_in_session）', () => {
  const { catalog } = buildPluginReferenceCatalog([plugin('a@m', false)]);
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0]?.enabled, false);
});

test('查不到返回undefined', () => {
  const { catalog } = buildPluginReferenceCatalog([plugin('a@m')]);
  assert.equal(findPluginCatalogEntry(catalog, 'nope@m'), undefined);
  assert.equal(findPluginCatalogEntry(undefined, 'a@m'), undefined);
});

test('空输入得到空目录', () => {
  assert.deepEqual(buildPluginReferenceCatalog([]), { catalog: { plugins: [] }, invalidPluginIds: [] });
});
