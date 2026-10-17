import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PLUGIN_REFERENCES_PER_TURN,
  extractPluginReferences,
  isValidPluginStableId,
} from '../src/references.js';

// ---------------------------------------------------------------------------
// 严格解析：身份只来自 destination，label 永不参与。
// ---------------------------------------------------------------------------

/** 造一条插件引用链接。 */
function ref(stableId: string, label = stableId): string {
  return `[${label}](plugin://${stableId})`;
}

test('从链接里解析出插件身份', () => {
  const result = extractPluginReferences(`用 ${ref('my-plugin@official')} 试试`);
  assert.deepEqual(result.references, ['my-plugin@official']);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.truncatedCount, 0);
});

test('label绝不参与身份判定', () => {
  // 人眼看到的是可信名字，机器读到的却是另一个插件 —— 只要 label 参与任何判定，
  // 这种欺骗就成立。这是本模块最核心的一条。
  const result = extractPluginReferences('[官方插件@official](plugin://evil@attacker)');
  assert.deepEqual(result.references, ['evil@attacker']);
});

test('label像插件但不是链接时什么都不解析', () => {
  // 纯文本 `@name` 不是引用：界面负责把它变成链接，解析器不猜。
  assert.deepEqual(extractPluginReferences('用 @my-plugin@official 试试').references, []);
});

test('协议名大小写敏感：大写变体不算引用但计入非法', () => {
  // 接受 `Plugin://` 等于让两套语义都能进，而下游只按一种做过滤。
  for (const variant of ['Plugin://a@b', 'PLUGIN://a@b']) {
    const result = extractPluginReferences(`[x](${variant})`);
    assert.deepEqual(result.references, [], variant);
    assert.equal(result.invalidCount, 1, `${variant} 应计入非法`);
  }
});

test('不做隐式percent-decoding', () => {
  // `%40` 解码后才是 `@`。先解码再判断 = 先信任再检查，等于没检查。
  const result = extractPluginReferences('[x](plugin://a%40b)');
  assert.deepEqual(result.references, []);
  assert.equal(result.invalidCount, 1);
});

test('拒绝query与fragment', () => {
  for (const bad of ['plugin://a@b?x=1', 'plugin://a@b#frag', 'plugin://a@b?']) {
    const result = extractPluginReferences(`[x](${bad})`);
    assert.deepEqual(result.references, [], bad);
    assert.equal(result.invalidCount, 1, bad);
  }
});

test('拒绝credentials与空白', () => {
  for (const bad of ['plugin://u:p@a@b', 'plugin://a b@c', 'plugin:// a@b']) {
    const result = extractPluginReferences(`[x](${bad})`);
    assert.deepEqual(result.references, [], bad);
  }
});

test('拒绝控制字符', () => {
  const result = extractPluginReferences('[x](plugin://a\u0000@b)');
  assert.deepEqual(result.references, []);
});

test('stable id必须恰好一个@且不在开头', () => {
  for (const bad of ['@b', 'a@', 'a@b@c', '']) {
    assert.equal(isValidPluginStableId(bad), false, bad);
  }
  assert.equal(isValidPluginStableId('a@b'), true);
});

test('段首必须是字母数字', () => {
  assert.equal(isValidPluginStableId('a@b'), true);
  assert.equal(isValidPluginStableId('1@b'), true);
  // 首字符是 `.` 或 `-` 的不合法（避免 `.` / `..` 一类路径式名字）。
  assert.equal(isValidPluginStableId('.a@b'), false);
  assert.equal(isValidPluginStableId('-a@b'), false);
});

test('stable id长度上限', () => {
  // 上限 256：255 个 a + `@` + `b` = 257，超一个字符。
  assert.equal(isValidPluginStableId(`${'a'.repeat(255)}@b`), false);
  assert.equal(isValidPluginStableId(`${'a'.repeat(254)}@b`), true);
  assert.equal(isValidPluginStableId(`${'a'.repeat(120)}@${'b'.repeat(120)}`), true);
});

test('去重保序：位置取首次出现', () => {
  // 顺序会影响 reminder 的预算分配，所以不能让它取决于集合的迭代顺序。
  const result = extractPluginReferences(
    [ref('a@m'), ref('b@m'), ref('a@m'), ref('c@m')].join(' '),
  );
  assert.deepEqual(result.references, ['a@m', 'b@m', 'c@m']);
});

test('单轮上限与截断计数', () => {
  const ids = Array.from({ length: MAX_PLUGIN_REFERENCES_PER_TURN + 3 }, (_, index) => `p${index}@m`);
  const result = extractPluginReferences(ids.map((id) => ref(id)).join(' '));
  assert.equal(result.references.length, MAX_PLUGIN_REFERENCES_PER_TURN);
  assert.equal(result.truncatedCount, 3);
  // 保留的是**先出现的**那些。
  assert.equal(result.references[0], 'p0@m');
});

test('去重发生在截断之前', () => {
  // 重复引用不该占额度，否则用户多写几遍同一个插件就把别人的额度吃掉了。
  const parts = [ref('a@m'), ref('a@m'), ref('b@m')];
  const result = extractPluginReferences(parts.join(' '));
  assert.deepEqual(result.references, ['a@m', 'b@m']);
  assert.equal(result.truncatedCount, 0);
});

test('额度已满时，重复引用不算截断', () => {
  // 这是"去重先于截断"唯一可观察的差别：额度满了之后再提一次已引用过的插件，
  // 若先判截断，它会被记成"截断了"—— 诊断于是虚报，而人会去找"哪个插件被丢了"，
  // 其实一个都没丢。
  const distinct = Array.from({ length: MAX_PLUGIN_REFERENCES_PER_TURN }, (_, index) => ref(`p${index}@m`));
  const result = extractPluginReferences([...distinct, ref('p0@m')].join(' '));
  assert.equal(result.references.length, MAX_PLUGIN_REFERENCES_PER_TURN);
  assert.equal(result.truncatedCount, 0, '重复不应计入截断');
});

test('支持尖括号形式的destination', () => {
  const result = extractPluginReferences('[x](<plugin://a@b>)');
  assert.deepEqual(result.references, ['a@b']);
});

test('label里的转义不影响解析', () => {
  const result = extractPluginReferences('[a\\]b](plugin://x@y)');
  assert.deepEqual(result.references, ['x@y']);
});

test('非插件链接被忽略且不计非法', () => {
  const result = extractPluginReferences('[文档](https://example.com) [文件](file:///tmp/a)');
  assert.deepEqual(result.references, []);
  assert.equal(result.invalidCount, 0);
});

test('同一条消息里的多个引用按出现顺序', () => {
  const result = extractPluginReferences(`先 ${ref('z@m')} 再 ${ref('a@m')}`);
  assert.deepEqual(result.references, ['z@m', 'a@m']);
});

test('空输入没有引用', () => {
  assert.deepEqual(extractPluginReferences(''), { references: [], truncatedCount: 0, invalidCount: 0 });
});

test('代码块里的链接也算引用（已知限制，写清楚）', () => {
  // 正确跳过需要完整的 Markdown 块级解析，本模块只做行级扫描。
  // 可接受的理由：上限是"多提示一个已启用插件"，不是"让模型执行什么"。
  // 这条测试把行为钉住，免得后人以为它"应该"被跳过而当成 bug 修一半。
  const result = extractPluginReferences('```\n[x](plugin://a@b)\n```');
  assert.deepEqual(result.references, ['a@b']);
});
