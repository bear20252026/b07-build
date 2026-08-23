import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, sep } from 'node:path';

const roots = ['packages', 'apps'];
const ignoredDirectories = new Set(['node_modules', 'dist', 'target', 'resources', '.git']);

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await collectTests(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts') && path.split(sep).includes('test')) files.push(path);
  }
  return files;
}

const testFiles = (await Promise.all(roots.map(collectTests))).flat().sort();
if (testFiles.length === 0) throw new Error('No TypeScript test files were found.');

console.log(`Running ${testFiles.length} test files.`);
const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx', '--test', '--test-concurrency=1', ...testFiles], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

child.once('exit', (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
