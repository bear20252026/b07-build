import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const sourceExtensions = new Set(['.ts', '.tsx', '.rs', '.py']);
const violations = [];

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'target', '.git'].includes(entry)) return [];
      return walk(fullPath);
    }
    return sourceExtensions.has(fullPath.slice(fullPath.lastIndexOf('.'))) ? [fullPath] : [];
  });
}

function contents(path) {
  return readFileSync(path, 'utf8');
}

function assertNoMatch(paths, pattern, rule) {
  for (const path of paths) {
    if (pattern.test(contents(path))) violations.push(`${rule}: ${relative(root, path)}`);
    pattern.lastIndex = 0;
  }
}

function assertMaxLines(path, maximum, rule) {
  const lines = contents(path).split('\n').length - 1;
  if (lines > maximum) violations.push(`${rule}: ${relative(root, path)} has ${lines} lines (max ${maximum})`);
}

const workbench = walk(join(root, 'apps/workbench/src'));
const domain = [...walk(join(root, 'packages')), ...walk(join(root, 'crates')), ...walk(join(root, 'sidecars'))];
const routes = walk(join(root, 'apps/runtime-gateway/src/http/routes'));

// 展示层只能通过浏览器 DTO 客户端和 Protocol 通信，不能触碰 Node、数据库或领域实现。
assertNoMatch(workbench, /(?:from\s+['"]node:|\bDatabaseSync\b|\bchild_process\b|from\s+['"]@awo\/(?:agent-runtime|provider-sdk|knowledge-workflow))/u, 'workbench-layer-leak');

// 领域包与跨语言控制面不允许反向依赖 application 层。
assertNoMatch(domain, /(?:from\s+['"](?:\.\.\/)*apps\/|@awo\/(?:workbench|runtime-gateway))/u, 'domain-reverse-app-dependency');

// HTTP route 是 primary adapter，不能在其中装配 SQLite、监听端口或读取进程配置。
assertNoMatch(routes, /(?:node:sqlite|\bDatabaseSync\b|\bcreateServer\b|\bprocess\.env\b|\bnew\s+Sqlite[A-Za-z0-9_]+)/u, 'route-infrastructure-leak');

assertMaxLines(join(root, 'apps/runtime-gateway/src/main.ts'), 40, 'gateway-entry-must-stay-thin');
assertMaxLines(join(root, 'apps/runtime-gateway/src/gateway-application.ts'), 350, 'gateway-composition-root-budget');
assertMaxLines(join(root, 'apps/runtime-gateway/src/http/router.ts'), 100, 'gateway-router-budget');

for (const oldPath of [
  'packages/agent-runtime/src/sqlite-task-snapshot-store.ts',
  'packages/agent-runtime/src/sqlite-session-snapshot-store.ts',
  'packages/agent-runtime/src/sqlite-memory-ledger-store.ts',
]) {
  try {
    statSync(join(root, oldPath));
    violations.push(`sqlite-adapter-must-live-in-infrastructure: ${oldPath}`);
  } catch {
    // 已迁入基础设施目录，符合边界规则。
  }
}

if (violations.length > 0) {
  console.error('Architecture boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Architecture boundary checks passed.');
}
