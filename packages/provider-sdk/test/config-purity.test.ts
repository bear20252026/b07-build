// 一个文件=一种作用：纯配置注册层「零 IO」边界的静态验收测试。
// 这不是风格检查：配置层一旦引入 node:/fetch/process.env，整条三层分离的依赖方向就断了。

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const configDirectory = fileURLToPath(new URL('../src/config', import.meta.url));

/** 递归收集配置层源文件；能力面契约子目录与配置层同守「零 IO」铁律，因此一并纳入。 */
function configSources(): readonly { readonly name: string; readonly text: string }[] {
  return collectSources(configDirectory, 'config');
}

function collectSources(directory: string, prefix: string): { name: string; text: string }[] {
  const sources: { name: string; text: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      sources.push(...collectSources(join(directory, entry.name), relative));
    } else if (entry.name.endsWith('.ts')) {
      sources.push({ name: relative, text: readFileSync(join(directory, entry.name), 'utf8') });
    }
  }
  return sources;
}

const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'node: 内置模块导入', pattern: /from\s+['"]node:/u },
  { label: '直接调用 fetch', pattern: /\bfetch\s*\(/u },
  { label: '读取环境变量', pattern: /\bprocess\.env\b/u },
  { label: 'CommonJS require', pattern: /\brequire\s*\(/u },
  { label: '动态 import()', pattern: /\bimport\s*\(/u },
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/u },
  { label: '文件系统 API', pattern: /\b(readFileSync|writeFileSync|readdirSync|createReadStream)\b/u },
];

test('纯配置层：全部源文件不含任何 IO 或网络调用', () => {
  const sources = configSources();
  assert.ok(sources.length >= 4, `配置层源文件数量异常：${sources.length}`);
  for (const source of sources) {
    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      assert.doesNotMatch(source.text, pattern, `config/${source.name} 违反零 IO 约束：${label}`);
    }
  }
});

test('纯配置层：不反向依赖远端目录层或执行适配层', () => {
  for (const source of configSources()) {
    assert.doesNotMatch(source.text, /from\s+['"][^'"]*(catalog|execution)/u, `config/${source.name} 出现反向依赖`);
  }
});
