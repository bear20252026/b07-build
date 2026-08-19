export const DESKTOP_BRIDGE_SCHEMA_VERSION = 1 as const;

export type DesktopReadOnlyCommand = 'runtime.health.read' | 'local-models.list';

export interface DesktopBridgeManifestV1 {
  schemaVersion: typeof DESKTOP_BRIDGE_SCHEMA_VERSION;
  windowLabel: string;
  allowedCommands: readonly DesktopReadOnlyCommand[];
  canExecute: false;
}

export interface DesktopBridgeIntentV1 {
  schemaVersion: typeof DESKTOP_BRIDGE_SCHEMA_VERSION;
  windowLabel: string;
  command: DesktopReadOnlyCommand;
}

export interface DesktopBridgeDecision {
  schemaVersion: typeof DESKTOP_BRIDGE_SCHEMA_VERSION;
  windowLabel: string;
  command: string;
  allowed: boolean;
  reason: string;
  canExecute: false;
}

const WINDOW_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const COMMANDS = new Set<DesktopReadOnlyCommand>(['runtime.health.read', 'local-models.list']);

function assertWindowLabel(value: string): void {
  if (!WINDOW_LABEL.test(value)) throw new Error('windowLabel 必须是 1-64 位安全标签');
}

function copyManifest(manifest: DesktopBridgeManifestV1): DesktopBridgeManifestV1 {
  return { ...manifest, allowedCommands: [...manifest.allowedCommands] };
}

/**
 * 宿主无关的桌面 IPC 审查器。它只表达可读取 metadata 的命令资格，
 * 不连接 runtime、不读文件、不启动进程，亦不替代 Gateway Policy/Approval。
 */
export class DesktopBridgeGuard {
  private readonly manifests = new Map<string, DesktopBridgeManifestV1>();

  register(manifest: DesktopBridgeManifestV1): DesktopBridgeManifestV1 {
    assertWindowLabel(manifest.windowLabel);
    if (manifest.schemaVersion !== DESKTOP_BRIDGE_SCHEMA_VERSION || manifest.canExecute !== false) {
      throw new Error('Desktop Bridge manifest 版本或执行边界无效');
    }
    if (manifest.allowedCommands.length === 0 || manifest.allowedCommands.some((command) => !COMMANDS.has(command))) {
      throw new Error('Desktop Bridge manifest 包含未声明或空的只读命令集');
    }
    if (new Set(manifest.allowedCommands).size !== manifest.allowedCommands.length) throw new Error('Desktop Bridge manifest 命令重复');
    if (this.manifests.has(manifest.windowLabel)) throw new Error(`Desktop Bridge window 已登记：${manifest.windowLabel}`);
    const stored = copyManifest(manifest);
    this.manifests.set(stored.windowLabel, stored);
    return copyManifest(stored);
  }

  decide(value: unknown): DesktopBridgeDecision {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return this.denied('unknown', 'unknown', 'IPC intent 必须是 object');
    }
    const intent = value as Partial<DesktopBridgeIntentV1>;
    if (intent.schemaVersion !== DESKTOP_BRIDGE_SCHEMA_VERSION || typeof intent.windowLabel !== 'string' || typeof intent.command !== 'string') {
      return this.denied(typeof intent.windowLabel === 'string' ? intent.windowLabel : 'unknown', typeof intent.command === 'string' ? intent.command : 'unknown', 'IPC intent contract 无效');
    }
    const keys = Object.keys(intent);
    if (keys.some((key) => !['schemaVersion', 'windowLabel', 'command'].includes(key))) {
      return this.denied(intent.windowLabel, intent.command, 'IPC intent 包含未声明字段');
    }
    const manifest = this.manifests.get(intent.windowLabel);
    if (!manifest) return this.denied(intent.windowLabel, intent.command, 'window 未登记 Desktop Bridge capability');
    if (!COMMANDS.has(intent.command as DesktopReadOnlyCommand) || !manifest.allowedCommands.includes(intent.command as DesktopReadOnlyCommand)) {
      return this.denied(intent.windowLabel, intent.command, 'command 未获该 window 的只读 capability');
    }
    return { schemaVersion: DESKTOP_BRIDGE_SCHEMA_VERSION, windowLabel: intent.windowLabel, command: intent.command, allowed: true, reason: '允许只读 metadata command', canExecute: false };
  }

  list(): readonly DesktopBridgeManifestV1[] {
    return [...this.manifests.values()].map(copyManifest).sort((left, right) => left.windowLabel.localeCompare(right.windowLabel));
  }

  private denied(windowLabel: string, command: string, reason: string): DesktopBridgeDecision {
    return { schemaVersion: DESKTOP_BRIDGE_SCHEMA_VERSION, windowLabel, command, allowed: false, reason, canExecute: false };
  }
}
