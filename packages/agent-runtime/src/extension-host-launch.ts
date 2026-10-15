// 一个文件=一种作用：把「激活计划选中的插件」映射成扩展宿主可启动的启动规格（fail-closed）。
//
// 链路补全：插件安装（带 mcpApp 后端声明） → ExtensionActivationPlanner 激活计划
// → 本模块产出 ExtensionLaunchSpec → desktop-shell 扩展宿主命令面拉起受监督子进程。
//
// 本模块只做纯映射：不 import 插件代码、不 spawn 进程、不解析凭据、不打开网络连接。
// 扩展宿主只接受**绝对可执行路径**（对应 Rust `is_absolute_executable`）；而插件的后端
// 声明（`mcpApp.serverId`）本身只是一个 MCP server 标识，不是路径，因此「声明 → 可执行
// 规格」的解析被抽成可注入的 `PluginBackendResolver` 适配器：解析不出来一律拒绝，
// 绝不猜测、绝不回退到 shell 字符串。

import type { McpServerManifest } from './mcp-registry.js';
import type { PluginMcpAppDeclaration } from './plugin-marketplace-types.js';
import type { ExtensionActivationPlan } from './extension-activation.js';
import type { ExtensionRegistry } from './extension-registry.js';

/** 与 Rust `ExtensionHostBudget` 对齐的资源预算（缺省即拒绝：不允许无上限）。 */
export interface ExtensionHostBudgetDraft {
  maxMemoryMb: number;
  maxCpuMs: number;
  maxStartupMs: number;
}

/** 与 Rust `ExtensionLaunchSpec` 对齐的启动规格（字段名在命令面转 camelCase）。 */
export interface ExtensionLaunchSpecDraft {
  extensionId: string;
  revision: number;
  /** 已经由适配器解析出的绝对可执行路径；绝不是 shell 字符串。 */
  executable: string;
  args: readonly string[];
  budget: ExtensionHostBudgetDraft;
}

/** 映射拒绝码：每一个都代表 fail-closed 的一个具体分支，便于审计与测试。 */
export type ExtensionLaunchRejectionCode =
  | 'PLAN_NOT_READY'
  | 'ENTRY_NOT_SELECTED'
  | 'MANIFEST_NOT_INSTALLED'
  | 'BACKEND_DECLARATION_MISSING'
  | 'BACKEND_NOT_RESOLVED'
  | 'EXECUTABLE_NOT_ABSOLUTE'
  | 'BUDGET_OUT_OF_RANGE'
  | 'ARGS_INVALID';

export interface ExtensionLaunchRejection {
  extensionId: string;
  revision: number;
  code: ExtensionLaunchRejectionCode;
  detail: string;
}

export interface ExtensionLaunchDecision {
  schemaVersion: 1;
  planId: string;
  outcome: 'ready' | 'blocked';
  launches: readonly ExtensionLaunchSpecDraft[];
  rejections: readonly ExtensionLaunchRejection[];
}

/** 适配器输出：已解析出的可执行素材；是否可用仍由本模块统一校验。 */
export interface PluginBackendResolution {
  executable: string;
  args: readonly string[];
  /** 解析来源标识（如 `mcp:<serverId>`），仅用于审计；不得携带凭据。 */
  resolvedBy: string;
}

/**
 * 可注入适配器：插件后端声明 → 宿主启动素材。
 * 返回 `undefined` 表示无法解析（缺失 / 未启用 / 非 stdio / 未登记），调用方必须拒绝。
 */
export interface PluginBackendResolver {
  resolve(declaration: PluginMcpAppDeclaration): PluginBackendResolution | undefined;
}

/** 最小只读端口：避免把整个 McpRegistry 耦合进启动映射。 */
export interface McpServerLookupPort {
  list(): readonly McpServerManifest[];
}

/**
 * 默认适配器：把插件 `mcpApp.serverId` 解析到已登记、已启用、stdio 传输的 MCP server
 * 的可执行声明。HTTP 传输（无本地进程）、未启用、已撤销、未登记一律返回 `undefined`。
 */
export class McpRegistryPluginBackendResolver implements PluginBackendResolver {
  constructor(private readonly servers: McpServerLookupPort) {}

  resolve(declaration: PluginMcpAppDeclaration): PluginBackendResolution | undefined {
    const server = this.servers.list().find((candidate) => candidate.id === declaration.serverId);
    if (!server || server.status !== 'enabled') return undefined;
    if (server.connection.transport !== 'stdio') return undefined;
    return {
      executable: server.connection.executable,
      args: [...server.connection.args],
      resolvedBy: `mcp:${server.id}`,
    };
  }
}

export interface PlanExtensionHostLaunchRequest {
  plan: ExtensionActivationPlan;
  registry: ExtensionRegistry;
  /** extensionId → 插件后端声明（来自 plugin.json 的 mcpApp）；缺项即拒绝。 */
  backendDeclarations: ReadonlyMap<string, PluginMcpAppDeclaration>;
  resolver: PluginBackendResolver;
}

/** 与 Rust 侧常量保持一致的上限；超限即拒绝，不做静默截断。 */
const MAX_MEMORY_MB = 4_096;
const MAX_CPU_MS = 3_600_000;
const MAX_STARTUP_MS = 60_000;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 1_024;

/** 绝对可执行路径：Windows 盘符绝对 / UNC / POSIX 绝对；其余（含 PATH 命令名）一律拒绝。 */
export function isAbsoluteExecutablePath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024) return false;
  if (/[\r\n\0]/u.test(value)) return false;
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith('/');
}

function budgetRejection(budget: ExtensionHostBudgetDraft): string | undefined {
  if (!Number.isSafeInteger(budget.maxMemoryMb) || budget.maxMemoryMb <= 0 || budget.maxMemoryMb > MAX_MEMORY_MB) {
    return `maxMemoryMb 必须在 1-${MAX_MEMORY_MB} 之间`;
  }
  if (!Number.isSafeInteger(budget.maxCpuMs) || budget.maxCpuMs <= 0 || budget.maxCpuMs > MAX_CPU_MS) {
    return `maxCpuMs 必须在 1-${MAX_CPU_MS} 之间`;
  }
  if (!Number.isSafeInteger(budget.maxStartupMs) || budget.maxStartupMs <= 0 || budget.maxStartupMs > MAX_STARTUP_MS) {
    return `maxStartupMs 必须在 1-${MAX_STARTUP_MS} 之间`;
  }
  return undefined;
}

function argsRejection(args: readonly string[]): string | undefined {
  if (args.length > MAX_ARGS) return `args 最多 ${MAX_ARGS} 项`;
  if (args.some((arg) => arg.length > MAX_ARG_LENGTH || /[\r\n\0]/u.test(arg))) {
    return `args 每项不得超过 ${MAX_ARG_LENGTH} 字符且不得含控制字符`;
  }
  return undefined;
}

/**
 * 把激活计划映射成启动规格集合。任何一条不满足即产出拒绝项，**绝不**放行。
 * 返回的 `launches` 只包含同时满足以下条件的条目：
 * 计划 outcome=ready、条目 decision=selected、manifest 仍为 installed、
 * 存在插件后端声明、适配器解析成功、可执行路径为绝对路径、预算与 args 合法。
 */
export function planExtensionHostLaunch(request: PlanExtensionHostLaunchRequest): ExtensionLaunchDecision {
  const { plan, registry, backendDeclarations, resolver } = request;
  const launches: ExtensionLaunchSpecDraft[] = [];
  const rejections: ExtensionLaunchRejection[] = [];
  const reject = (extensionId: string, revision: number, code: ExtensionLaunchRejectionCode, detail: string): void => {
    rejections.push({ extensionId, revision, code, detail });
  };
  const planReady = plan.outcome === 'ready';
  for (const entry of plan.entries) {
    if (!planReady) {
      reject(entry.extensionId, entry.revision, 'PLAN_NOT_READY', '激活计划整体为 blocked，任何条目都不得启动');
      continue;
    }
    if (entry.decision !== 'selected') {
      reject(entry.extensionId, entry.revision, 'ENTRY_NOT_SELECTED', `条目决策为 ${entry.decision}，未激活/未授权不得启动`);
      continue;
    }
    const manifest = registry.get(entry.extensionId);
    if (!manifest || manifest.status !== 'installed') {
      reject(entry.extensionId, entry.revision, 'MANIFEST_NOT_INSTALLED', `registry 中不存在 installed manifest（当前 ${manifest?.status ?? 'missing'}）`);
      continue;
    }
    const declaration = backendDeclarations.get(entry.extensionId);
    if (!declaration) {
      reject(entry.extensionId, entry.revision, 'BACKEND_DECLARATION_MISSING', '插件未声明后端（mcpApp），无从映射为可执行路径');
      continue;
    }
    const resolution = resolver.resolve(declaration);
    if (!resolution) {
      reject(entry.extensionId, entry.revision, 'BACKEND_NOT_RESOLVED', `后端声明 serverId=${declaration.serverId} 无法解析为本地可执行进程`);
      continue;
    }
    if (!isAbsoluteExecutablePath(resolution.executable)) {
      reject(entry.extensionId, entry.revision, 'EXECUTABLE_NOT_ABSOLUTE', '扩展宿主只接受绝对可执行路径，拒绝相对路径或 PATH 命令名');
      continue;
    }
    const budget: ExtensionHostBudgetDraft = {
      maxMemoryMb: manifest.resourceBudget.maxMemoryMb,
      maxCpuMs: manifest.resourceBudget.maxCpuMs,
      maxStartupMs: manifest.resourceBudget.maxStartupMs,
    };
    const budgetDetail = budgetRejection(budget);
    if (budgetDetail) {
      reject(entry.extensionId, entry.revision, 'BUDGET_OUT_OF_RANGE', budgetDetail);
      continue;
    }
    const argsDetail = argsRejection(resolution.args);
    if (argsDetail) {
      reject(entry.extensionId, entry.revision, 'ARGS_INVALID', argsDetail);
      continue;
    }
    launches.push({
      extensionId: entry.extensionId,
      revision: entry.revision,
      executable: resolution.executable,
      args: [...resolution.args],
      budget,
    });
  }
  return {
    schemaVersion: 1,
    planId: plan.planId,
    outcome: launches.length > 0 ? 'ready' : 'blocked',
    launches,
    rejections,
  };
}
