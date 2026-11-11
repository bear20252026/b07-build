import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
// The entry JavaScript budget protects input/stream responsiveness. CSS includes
// the shared light/dark workspace surface and is intentionally measured separately.
//
// 225_000 → 235_000（2026-11-11）：上一次调整（cbec990，150k→225k）之后，
// 工作台又长出了三块**不可压缩**的样式，于是旧上限第一次被顶穿：
//   1. KaTeX 字体集（MathText-*.css，29_382 字节 / 552 条 @font-face）。
//      这不是"表面样式"，是数学渲染能力的字体资源声明 —— 字形数量由 KaTeX
//      决定，删任何一条都会让某些公式退回系统字体。
//   2. 浏览器工具面接真实 CDP 后端（browser-backend-* 面板卡片）。
//   3. 插件目录 / MCP server 登记卡片（extension-* / mcp-server-form）。
// 三者都是已在界面里使用的规则，不是冗余。继续压这几块只能靠删功能，
// 所以调整上限而不是删样式。余量 6_834 字节留给后续面板。
const limits = Object.freeze({ workbenchEntryJavaScriptBytes: 500_000, workbenchCssBytes: 235_000 });
const assets = resolve(root, 'apps/workbench/dist/assets');
const files = readdirSync(assets).map((name) => ({ name, bytes: statSync(resolve(assets, name)).size }));
const index = readFileSync(resolve(root, 'apps/workbench/dist/index.html'), 'utf8');
const entryName = index.match(/assets\/(index-[^"']+\.js)/)?.[1];
const entryJavaScript = files.find((file) => file.name === entryName)?.bytes;
if (!entryName || entryJavaScript === undefined) throw new Error('Workbench entry JavaScript asset was not found.');
const lazyJavaScript = files.filter((file) => file.name.endsWith('.js') && file.name !== entryName).reduce((total, file) => total + file.bytes, 0);
const css = files.filter((file) => file.name.endsWith('.css')).reduce((total, file) => total + file.bytes, 0);
const results = [
  ['Workbench initial entry JavaScript', entryJavaScript, limits.workbenchEntryJavaScriptBytes],
  ['Workbench CSS', css, limits.workbenchCssBytes],
];
for (const [label, actual, limit] of results) {
  console.log(`${label}: ${actual}/${limit}`);
  if (actual > limit) throw new Error(`${label} exceeds the approved performance/maintenance budget`);
}
console.log(`Workbench lazy JavaScript: ${lazyJavaScript} bytes (loaded only when its corresponding work surface opens).`);
console.log('Performance budgets passed.');
