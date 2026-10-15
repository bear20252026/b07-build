// 一个文件=一种作用：扩展宿主命令面的 workbench 侧桥（Tauri invoke 封装）。
//
// 进程 spawn / 监督 / 预算 / cgroup 全在原生侧（crates/process-supervisor 的
// extension_host 纯逻辑 + desktop-shell 的 extension_host_process 命令面）。
// 这里只做三件事：start（extension_host_start）、status（extension_host_status 快照）、
// stop（extension_host_stop）。依赖项可注入以便测试；非 Tauri 运行时（浏览器）默认拒绝。

import { invoke } from '@tauri-apps/api/core';

/** 与 agent-runtime `ExtensionLaunchSpecDraft` 同形的启动规格（camelCase 过桥）。 */
export interface ExtensionHostLaunchSpec {
  readonly extensionId: string;
  readonly revision: number;
  /** 绝对可执行路径；相对路径 / PATH 命令名在客户端即拒绝。 */
  readonly executable: string;
  readonly args?: readonly string[];
  readonly budget: Readonly<{ maxMemoryMb: number; maxCpuMs: number; maxStartupMs: number }>;
}

export interface ExtensionHostSnapshot {
  readonly protocolVersion: string;
  readonly extensionId: string;
  readonly revision: number;
  readonly resourceEnforcement: string;
  readonly state: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly exitCode: number | null;
  readonly detail: string | null;
}

export interface ExtensionHostClientDeps {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
}

const defaultDeps: ExtensionHostClientDeps = {
  invoke: (command, args) => invoke(command, args),
};

function nativeRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** 与 Rust `is_absolute_executable` / agent-runtime `isAbsoluteExecutablePath` 同语义的本地护栏。 */
function isAbsoluteExecutablePath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024 || /[\r\n\0]/u.test(value)) return false;
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith('/');
}

function toSnapshot(payload: unknown): ExtensionHostSnapshot | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload as ExtensionHostSnapshot;
}

/**
 * 扩展宿主客户端。`start` 幂等：原生侧对同一 extension/revision 重复启动返回当前快照；
 * `stop` 幂等：未运行时原生侧返回 `null`；`status` 未运行时返回 `null`。
 */
export class ExtensionHostClient {
  private readonly deps: ExtensionHostClientDeps;

  constructor(deps?: ExtensionHostClientDeps) {
    this.deps = deps ?? defaultDeps;
  }

  private assertNative(): void {
    if (!nativeRuntime() && this.deps === defaultDeps) {
      throw new Error('extension-host-native-unavailable');
    }
  }

  async start(spec: ExtensionHostLaunchSpec): Promise<ExtensionHostSnapshot> {
    this.assertNative();
    if (!isAbsoluteExecutablePath(spec.executable)) {
      throw new Error('extension-host-executable-not-absolute');
    }
    const snapshot = toSnapshot(await this.deps.invoke('extension_host_start', {
      request: {
        extensionId: spec.extensionId,
        revision: spec.revision,
        executable: spec.executable,
        args: spec.args ?? [],
        budget: {
          maxMemoryMb: spec.budget.maxMemoryMb,
          maxCpuMs: spec.budget.maxCpuMs,
          maxStartupMs: spec.budget.maxStartupMs,
        },
      },
    }));
    if (!snapshot) throw new Error('extension-host-start-invalid-response');
    return snapshot;
  }

  /** 未运行返回 null；已运行返回停止后的终态快照。 */
  async stop(): Promise<ExtensionHostSnapshot | null> {
    this.assertNative();
    return toSnapshot(await this.deps.invoke('extension_host_stop', {}));
  }

  /** 未运行返回 null；否则返回当前监督快照（含 Spawned/Healthy/Exited 等状态）。 */
  async status(): Promise<ExtensionHostSnapshot | null> {
    this.assertNative();
    return toSnapshot(await this.deps.invoke('extension_host_status', {}));
  }
}
