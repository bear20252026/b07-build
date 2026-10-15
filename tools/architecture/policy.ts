/**
 * 架构治理策略引擎（spec-first 的“策略 → 代码”检查）。
 *
 * 设计要点：
 * 1. 策略先行：`architecture-policy.yaml` 声明模块的 `roots` / `managed` /
 *    `requires` / `publicEntrypoints` / `owner`。先改策略，再改代码。
 * 2. 只对“新增”违规失败：`.architecture-baseline.json` 是存量违规白名单，
 *    检查结果按**稳定指纹**与基线比对，只有指纹不在基线里的违规才会让
 *    `architecture:check` 退出码非 0。
 * 3. 稳定指纹：`sha256(rule \0 仓库相对路径 \0 detail)` 取前 16 位十六进制。
 *    指纹**不含行号**，也不含绝对路径，所以：
 *      - 同一文件里违规上下移动不会造成基线漂移；
 *      - 换机器/换工作目录不会造成基线漂移；
 *      - 文件被移动或改名视为真实变更，需要更新基线（这是刻意的）。
 *    对行数这类“天然会变”的 detail（如文件行数）一律不写进 detail，避免
 *    一次无关改动就让基线失效。
 * 4. `managed: true` 的模块受强校验；`managed: false` 是存量 legacy，只记录
 *    依赖关系不阻塞（对应策略文件头的设计意图）。
 *
 * 本文件同时是 CLI 入口（直接运行时执行 `main`），并被测试直接 import，
 * 因此所有逻辑都保持纯函数、无副作用（除读写策略/基线/依赖图文件）。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { parseYamlSubset, YamlSubsetError, type YamlValue } from './yaml.js';

/** 参与依赖分析的源码扩展名（与 tsconfig / depcruise 覆盖范围保持一致）。 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'target', '.git', 'out', 'coverage', 'resources']);
const POLICY_FILENAME = 'architecture-policy.yaml';
const BASELINE_FILENAME = '.architecture-baseline.json';
export const DEPENDENCY_GRAPH_FILENAME = 'dependency-graph.mmd';

export interface PolicyModule {
  id: string;
  /** 源码目录，仓库根相对 posix 路径。 */
  roots: string[];
  /** true = 受强校验；false = 存量 legacy，只记录不阻塞。 */
  managed: boolean;
  /** 允许依赖的模块 id。 */
  requires: string[];
  /** 允许被外部引用的入口文件，仓库根相对 posix 路径。 */
  publicEntrypoints: string[];
  owner: string | null;
}

export interface ArchitecturePolicy {
  version: 1;
  modules: PolicyModule[];
  global: {
    forbidCycles: boolean;
    forbidDeepImports: boolean;
    managedOnly: boolean;
  };
}

export interface Violation {
  rule: string;
  /** 违规文件，仓库根相对 posix 路径。 */
  file: string;
  module: string | null;
  /** 稳定细节：只放不随行号变化的信息。 */
  detail: string;
  message: string;
  fingerprint: string;
}

export interface BaselineFile {
  version: number;
  violations: Array<{ fingerprint: string; rule?: string; file?: string; message?: string }>;
}

export interface ModuleEdge {
  from: string;
  to: string;
}

export interface ArchitectureResult {
  policy: ArchitecturePolicy;
  violations: Violation[];
  baselineViolations: Violation[];
  newViolations: Violation[];
  edges: ModuleEdge[];
}

export interface CheckOptions {
  cwd?: string;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function repoPath(cwd: string, absolutePath: string): string {
  return toPosix(relative(cwd, absolutePath));
}

function asObject(value: YamlValue, context: string): { [key: string]: YamlValue } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} 必须是映射`);
  }
  return value;
}

function asString(value: YamlValue, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} 必须是非空字符串`);
  return value;
}

function asStringArray(value: YamlValue, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} 必须是序列`);
  return value.map((item, index) => asString(item, `${context}[${index}]`));
}

function asBoolean(value: YamlValue | undefined, fallback: boolean, context: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${context} 必须是布尔值`);
  return value;
}

/** 校验并归一化策略对象。 */
export function validatePolicy(parsed: YamlValue): ArchitecturePolicy {
  const root = asObject(parsed, 'architecture-policy.yaml');
  if (root.version !== 1) throw new Error('architecture-policy.yaml 必须声明 version: 1');
  const rawModules = root.modules;
  if (!Array.isArray(rawModules) || rawModules.length === 0) {
    throw new Error('architecture-policy.yaml 必须包含非空 modules 序列');
  }

  const seen = new Set<string>();
  const modules: PolicyModule[] = rawModules.map((raw, index) => {
    const module = asObject(raw, `modules[${index}]`);
    const id = asString(module.id ?? null, `modules[${index}].id`);
    if (seen.has(id)) throw new Error(`模块 id 重复：${id}`);
    seen.add(id);
    const roots = asStringArray(module.roots ?? null, `模块 ${id} 的 roots`).map(toPosix);
    if (roots.length === 0) throw new Error(`模块 ${id} 必须声明至少一个 root`);
    const requires = module.requires === undefined ? [] : asStringArray(module.requires, `模块 ${id} 的 requires`);
    const publicEntrypoints =
      module.publicEntrypoints === undefined
        ? []
        : asStringArray(module.publicEntrypoints, `模块 ${id} 的 publicEntrypoints`).map(toPosix);
    const owner = module.owner === undefined || module.owner === null ? null : asString(module.owner, `模块 ${id} 的 owner`);
    return {
      id,
      roots,
      managed: asBoolean(module.managed, false, `模块 ${id} 的 managed`),
      requires: [...new Set(requires)],
      publicEntrypoints: [...new Set(publicEntrypoints)],
      owner,
    };
  });

  const moduleIds = new Set(modules.map((module) => module.id));
  for (const module of modules) {
    for (const dependency of module.requires) {
      if (!moduleIds.has(dependency)) throw new Error(`模块 ${module.id} 依赖了未声明的模块 ${dependency}`);
    }
  }

  const global = asObject(root.global ?? {}, 'global');
  return {
    version: 1,
    modules,
    global: {
      forbidCycles: asBoolean(global.forbidCycles, true, 'global.forbidCycles'),
      forbidDeepImports: asBoolean(global.forbidDeepImports, true, 'global.forbidDeepImports'),
      managedOnly: asBoolean(global.managedOnly, true, 'global.managedOnly'),
    },
  };
}

/** 从磁盘读取并校验策略文件。 */
export function loadPolicy(cwd: string = process.cwd()): ArchitecturePolicy {
  const filename = join(cwd, POLICY_FILENAME);
  if (!existsSync(filename)) throw new Error(`找不到架构策略文件：${POLICY_FILENAME}`);
  let parsed: YamlValue;
  try {
    parsed = parseYamlSubset(readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error instanceof YamlSubsetError) throw new Error(`${POLICY_FILENAME} 解析失败：${error.message}`);
    throw error;
  }
  return validatePolicy(parsed);
}

/** 稳定指纹：sha256(rule \0 仓库相对文件 \0 detail) 前 16 位。 */
export function fingerprint(rule: string, file: string, detail: string): string {
  return createHash('sha256').update(`${rule}\0${toPosix(file)}\0${detail}`).digest('hex').slice(0, 16);
}

function makeViolation(input: {
  rule: string;
  file: string;
  module: string | null;
  detail: string;
  message: string;
}): Violation {
  return { ...input, fingerprint: fingerprint(input.rule, input.file, input.detail) };
}

/** 递归收集模块 roots 下的源码文件（绝对路径，已排序）。 */
function walkSourceFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...walkSourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files.sort();
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 生成某路径的候选文件（含 TS 源码写 .js 扩展名指向 .ts 的约定）。 */
function candidateFiles(base: string): string[] {
  const extension = extname(base).toLowerCase();
  const candidates: string[] = [];
  if (extension !== '') {
    candidates.push(base);
    const withoutExtension = base.slice(0, base.length - extension.length);
    for (const candidate of SOURCE_EXTENSIONS) candidates.push(`${withoutExtension}${candidate}`);
  } else {
    for (const candidate of SOURCE_EXTENSIONS) candidates.push(`${base}${candidate}`);
    for (const candidate of SOURCE_EXTENSIONS) candidates.push(join(base, `index${candidate}`));
  }
  return candidates;
}

interface WorkspacePackage {
  dir: string;
  main: string | null;
  exports: Record<string, string>;
}

/** 读取 packages/*、apps/* 的 package.json，建立“包名 → 目录/exports”映射。 */
function loadWorkspacePackages(cwd: string): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const group of ['packages', 'apps']) {
    const groupDirectory = join(cwd, group);
    if (!isDirectory(groupDirectory)) continue;
    for (const entry of readdirSync(groupDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(groupDirectory, entry.name, 'package.json');
      if (!isFile(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: unknown;
        main?: unknown;
        exports?: unknown;
      };
      if (typeof manifest.name !== 'string') continue;
      const exportsMap: Record<string, string> = {};
      if (manifest.exports !== null && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)) {
        for (const [key, value] of Object.entries(manifest.exports)) {
          if (typeof value === 'string') exportsMap[key] = value;
        }
      }
      packages.set(manifest.name, {
        dir: join(groupDirectory, entry.name),
        main: typeof manifest.main === 'string' ? manifest.main : null,
        exports: exportsMap,
      });
    }
  }
  return packages;
}

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  return candidateFiles(base).find(isFile) ?? null;
}

function resolveWorkspaceImport(specifier: string, workspace: Map<string, WorkspacePackage>): string | null {
  if (!specifier.startsWith('@')) return null;
  const parts = specifier.split('/');
  const packageName = parts.slice(0, 2).join('/');
  const pkg = workspace.get(packageName);
  if (!pkg) return null;
  const subpath = parts.slice(2).join('/');
  const mapped = subpath === '' ? pkg.exports['.'] ?? pkg.main : pkg.exports[`./${subpath}`] ?? null;
  if (mapped !== null) {
    const absolute = resolve(pkg.dir, mapped);
    if (isFile(absolute)) return absolute;
    const found = candidateFiles(absolute).find(isFile);
    if (found) return found;
  }
  if (subpath !== '') {
    const fallback = candidateFiles(join(pkg.dir, subpath)).find(isFile);
    if (fallback) return fallback;
  }
  return null;
}

function scriptKindFor(file: string): ts.ScriptKind {
  const extension = extname(file).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** 用 TypeScript 解析器提取 import/export/dynamic import 的模块说明符。 */
export function importsOf(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0] as ts.Expression)
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

interface ModuleFile {
  module: PolicyModule;
  file: string;
  source: string;
}

/** 为每个模块收集源码文件，并做策略完整性检查（root / 入口是否存在）。 */
function collectModuleFiles(cwd: string, policy: ArchitecturePolicy): { files: ModuleFile[]; violations: Violation[] } {
  const violations: Violation[] = [];
  const files: ModuleFile[] = [];
  for (const module of policy.modules) {
    const moduleFiles: string[] = [];
    for (const root of module.roots) {
      const absoluteRoot = resolve(cwd, root);
      if (!isDirectory(absoluteRoot)) {
        violations.push(
          makeViolation({
            rule: 'missing-module-root',
            file: root,
            module: module.id,
            detail: root,
            message: `模块 ${module.id} 声明的 root 不存在：${root}`,
          }),
        );
        continue;
      }
      moduleFiles.push(...walkSourceFiles(absoluteRoot));
    }
    for (const entrypoint of module.publicEntrypoints) {
      if (!isFile(resolve(cwd, entrypoint))) {
        violations.push(
          makeViolation({
            rule: 'missing-public-entrypoint',
            file: entrypoint,
            module: module.id,
            detail: entrypoint,
            message: `模块 ${module.id} 声明的 publicEntrypoint 不存在：${entrypoint}`,
          }),
        );
      }
    }
    for (const file of moduleFiles) {
      files.push({ module, file, source: readFileSync(file, 'utf8') });
    }
  }
  return { files, violations };
}

function moduleForFile(cwd: string, file: string, policy: ArchitecturePolicy): PolicyModule | null {
  const candidates = policy.modules
    .filter((module) => module.roots.some((root) => isUnder(resolve(cwd, root), file)))
    .sort((a, b) => longestRoot(cwd, b) - longestRoot(cwd, a));
  return candidates[0] ?? null;
}

function isUnder(root: string, file: string): boolean {
  const relativePath = relative(root, file);
  return relativePath !== '' && !relativePath.startsWith('..');
}

function longestRoot(cwd: string, module: PolicyModule): number {
  return Math.max(...module.roots.map((root) => resolve(cwd, root).length));
}

/** 模块级循环依赖检测，返回唯一环的模块 id 链。 */
function detectCycles(edges: ModuleEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  for (const list of adjacency.values()) list.sort();

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();
  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 1) {
        const start = stack.indexOf(next);
        const cycle = stack.slice(start).concat(next);
        const key = [...new Set(cycle)].sort().join(' -> ');
        cycles.set(key, cycle);
      } else if (!state.get(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of [...adjacency.keys()].sort()) if (!state.get(node)) visit(node);
  return [...cycles.values()];
}

/** 读取基线白名单；缺失或损坏时退化为空基线。 */
export function readBaseline(cwd: string = process.cwd()): BaselineFile {
  const filename = join(cwd, BASELINE_FILENAME);
  if (!existsSync(filename)) return { version: 1, violations: [] };
  try {
    const parsed = JSON.parse(readFileSync(filename, 'utf8')) as BaselineFile;
    if (!Array.isArray(parsed.violations)) return { version: 1, violations: [] };
    return { version: 1, violations: parsed.violations };
  } catch {
    return { version: 1, violations: [] };
  }
}

/** 写入基线白名单（按指纹排序，保证可复现 diff）。 */
export function updateBaseline(cwd: string, violations: Violation[]): BaselineFile {
  const entries = [...violations]
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
    .map((violation) => ({
      fingerprint: violation.fingerprint,
      rule: violation.rule,
      file: violation.file,
      message: violation.message,
    }));
  const baseline: BaselineFile = { version: 1, violations: entries };
  writeFileSync(join(cwd, BASELINE_FILENAME), `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

/** 执行架构策略检查。 */
export function checkArchitecture(options: CheckOptions = {}): ArchitectureResult {
  const cwd = options.cwd ?? process.cwd();
  const policy = loadPolicy(cwd);
  const workspace = loadWorkspacePackages(cwd);
  const { files, violations } = collectModuleFiles(cwd, policy);
  const edgeSet = new Set<string>();
  const edges: ModuleEdge[] = [];

  for (const { module, file, source } of files) {
    if (policy.global.managedOnly && !module.managed) continue;
    for (const specifier of importsOf(file, source)) {
      const target = specifier.startsWith('.')
        ? resolveRelativeImport(file, specifier)
        : resolveWorkspaceImport(specifier, workspace);
      if (target === null) continue;
      const targetModule = moduleForFile(cwd, target, policy);
      if (targetModule === null || targetModule.id === module.id) continue;

      const edgeKey = `${module.id}\0${targetModule.id}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({ from: module.id, to: targetModule.id });
      }

      if (!module.requires.includes(targetModule.id)) {
        violations.push(
          makeViolation({
            rule: 'module-dependency',
            file: repoPath(cwd, file),
            module: module.id,
            detail: targetModule.id,
            message: `模块 ${module.id} 未声明依赖 ${targetModule.id}（${repoPath(cwd, file)}）`,
          }),
        );
      }

      if (policy.global.forbidDeepImports && targetModule.publicEntrypoints.length > 0) {
        const targetPath = repoPath(cwd, target);
        if (!targetModule.publicEntrypoints.includes(targetPath)) {
          violations.push(
            makeViolation({
              rule: 'deep-import',
              file: repoPath(cwd, file),
              module: module.id,
              detail: targetPath,
              message: `跨模块引用必须走公开入口：${repoPath(cwd, file)} → ${targetPath}（模块 ${targetModule.id}）`,
            }),
          );
        }
      }
    }
  }

  if (policy.global.forbidCycles) {
    const managed = new Set(policy.modules.filter((module) => module.managed).map((module) => module.id));
    const managedEdges = edges.filter((edge) => managed.has(edge.from) && managed.has(edge.to));
    for (const cycle of detectCycles(managedEdges)) {
      const detail = [...new Set(cycle)].sort().join(' -> ');
      violations.push(
        makeViolation({
          rule: 'cycle',
          file: POLICY_FILENAME,
          module: null,
          detail,
          message: `检测到模块级循环依赖：${cycle.join(' -> ')}`,
        }),
      );
    }
  }

  const unique = new Map<string, Violation>();
  for (const violation of violations) unique.set(violation.fingerprint, violation);
  const all = [...unique.values()].sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.detail.localeCompare(b.detail),
  );

  const baseline = readBaseline(cwd);
  const baselineFingerprints = new Set(baseline.violations.map((item) => item.fingerprint));
  const baselineViolations = all.filter((violation) => baselineFingerprints.has(violation.fingerprint));
  const newViolations = all.filter((violation) => !baselineFingerprints.has(violation.fingerprint));

  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { policy, violations: all, baselineViolations, newViolations, edges };
}

/** 收集全量模块依赖边（含 legacy 模块），用于生成依赖图。 */
export function collectModuleEdges(cwd: string = process.cwd()): { policy: ArchitecturePolicy; edges: ModuleEdge[] } {
  const policy = loadPolicy(cwd);
  const workspace = loadWorkspacePackages(cwd);
  const { files } = collectModuleFiles(cwd, policy);
  const edgeSet = new Set<string>();
  const edges: ModuleEdge[] = [];
  for (const { module, file, source } of files) {
    for (const specifier of importsOf(file, source)) {
      const target = specifier.startsWith('.')
        ? resolveRelativeImport(file, specifier)
        : resolveWorkspaceImport(specifier, workspace);
      if (target === null) continue;
      const targetModule = moduleForFile(cwd, target, policy);
      if (targetModule === null || targetModule.id === module.id) continue;
      const key = `${module.id}\0${targetModule.id}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ from: module.id, to: targetModule.id });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { policy, edges };
}

function mermaidId(id: string): string {
  return `m_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** 生成 Mermaid 依赖图（确定性输出：节点/边均排序，LF 换行）。 */
export function renderDependencyGraph(policy: ArchitecturePolicy, edges: ModuleEdge[]): string {
  const lines: string[] = [
    '%% 架构模块依赖图：由 `npm run architecture:graph` 生成，请勿手工编辑。',
    '%% managed = 受 architecture-policy.yaml 强校验；legacy = 存量模块，仅记录。',
    'graph LR',
  ];
  const modules = [...policy.modules].sort((a, b) => a.id.localeCompare(b.id));
  for (const module of modules) {
    const suffix = module.managed ? 'managed' : 'legacy';
    lines.push(`  ${mermaidId(module.id)}["${module.id} (${suffix})"]`);
  }
  const known = new Set(modules.map((module) => module.id));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    lines.push(`  ${mermaidId(edge.from)} --> ${mermaidId(edge.to)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 文本报告（人类可读）。 */
export function formatReport(result: ArchitectureResult): string {
  const lines = [
    `architecture policy: ${result.newViolations.length === 0 ? 'OK' : 'FAILED'}`,
    `violations: ${result.violations.length}`,
    `baseline: ${result.baselineViolations.length}`,
    `new: ${result.newViolations.length}`,
  ];
  for (const violation of result.newViolations) {
    lines.push(`- ${violation.rule} ${violation.file}: ${violation.message}`);
  }
  return lines.join('\n');
}

/** CLI 入口（返回进程退出码）。 */
export function runCli(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): number {
  const command = argv[0] ?? 'check';
  if (command === 'baseline:update') {
    const result = checkArchitecture({ cwd });
    const baseline = updateBaseline(cwd, result.violations);
    console.log(`baseline updated: ${baseline.violations.length} violations`);
    return 0;
  }
  const result = checkArchitecture({ cwd });
  if (command === 'report') {
    console.log(JSON.stringify(result, null, 2));
    return result.newViolations.length > 0 ? 1 : 0;
  }
  console.log(formatReport(result));
  return result.newViolations.length > 0 ? 1 : 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const entryPath = resolve(entry);
  const modulePath = resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32'
    ? entryPath.toLowerCase() === modulePath.toLowerCase()
    : entryPath === modulePath;
}

if (isDirectRun()) {
  process.exitCode = runCli();
}
