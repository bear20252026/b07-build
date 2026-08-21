import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const limits = Object.freeze({ workbenchJavaScriptBytes: 500_000, workbenchCssBytes: 150_000, gatewayCompositionLines: 350 });
const assets = resolve(root, 'apps/workbench/dist/assets');
const files = readdirSync(assets).map((name) => ({ name, bytes: statSync(resolve(assets, name)).size }));
const javascript = files.filter((file) => file.name.endsWith('.js')).reduce((total, file) => total + file.bytes, 0);
const css = files.filter((file) => file.name.endsWith('.css')).reduce((total, file) => total + file.bytes, 0);
const gatewayLines = readFileSync(resolve(root, 'apps/runtime-gateway/src/gateway-application.ts'), 'utf8').split('\n').length - 1;
const results = [
  ['Workbench JavaScript', javascript, limits.workbenchJavaScriptBytes],
  ['Workbench CSS', css, limits.workbenchCssBytes],
  ['Gateway composition root lines', gatewayLines, limits.gatewayCompositionLines],
];
for (const [label, actual, limit] of results) {
  console.log(`${label}: ${actual}/${limit}`);
  if (actual > limit) throw new Error(`${label} exceeds the approved performance/maintenance budget`);
}
console.log('Performance budgets passed.');
