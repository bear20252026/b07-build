import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
// The entry JavaScript budget protects input/stream responsiveness. CSS includes
// the shared light/dark workspace surface and is intentionally measured separately.
const limits = Object.freeze({ workbenchEntryJavaScriptBytes: 500_000, workbenchCssBytes: 225_000 });
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
