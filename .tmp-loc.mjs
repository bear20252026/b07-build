import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** 用 git 索引取文件清单（自动排除 gitignore 的 node_modules / dist），再逐文件数行。 */
function measure(repo) {
  const listed = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const byExt = new Map();
  let total = 0;
  for (const relative of listed) {
    const ext = extname(relative).toLowerCase();
    if (!['.ts', '.tsx', '.rs', '.js', '.mjs', '.py'].includes(ext)) continue;
    let lines;
    try {
      lines = readFileSync(`${repo}/${relative}`, 'utf8').split('\n').length;
    } catch {
      continue;
    }
    total += lines;
    const bucket = byExt.get(ext) ?? { files: 0, lines: 0 };
    bucket.files += 1;
    bucket.lines += lines;
    byExt.set(ext, bucket);
  }
  return { total, tracked: listed.length, byExt: [...byExt.entries()].sort((a, b) => b[1].lines - a[1].lines) };
}

for (const [label, repo] of [['b07-build', 'D:/Workbuddy/2026-10-07-06-38-50/b07-build'], ['ZCode', 'D:/Workbuddy/2026-10-07-06-38-50/ZCode']]) {
  const result = measure(repo);
  process.stdout.write(`\n=== ${label} ===\n`);
  process.stdout.write(`git 跟踪文件 ${result.tracked}，代码合计 ${result.total} 行\n`);
  for (const [ext, stat] of result.byExt) process.stdout.write(`  ${ext.padEnd(6)} ${String(stat.files).padStart(5)} 文件  ${String(stat.lines).padStart(8)} 行\n`);
}
