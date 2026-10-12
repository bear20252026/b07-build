import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * ZCode 协议子进程的进程面客户端：spawn / stdin 写入 / 事件流。
 *
 * 进程语义全部在 Rust 侧（zcode_process.rs）；这里只做类型、invoke 门面与
 * 错误码翻译。依赖项可注入以便测试。
 */

export const ZCODE_LINE_EVENT = 'zcode-protocol-line';
export const ZCODE_EXIT_EVENT = 'zcode-protocol-exit';

export interface ZCodeLinePayload {
  readonly runId: string;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface ZCodeExitPayload {
  readonly runId: string;
  readonly code: number | null;
}

export interface ZCodeProcessDeps {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<UnlistenFn>;
}

const defaultDeps: ZCodeProcessDeps = {
  invoke: (command, args) => invoke(command, args),
  listen: (event, handler) => listen(event, handler),
};

function nativeRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

const errorTexts: Record<string, string> = {
  'zcode-run-id-invalid': 'ZCode 会话标识无效，请重试。',
  'zcode-executable-invalid': 'ZCode 可执行文件路径包含不允许的字符。',
  'zcode-executable-not-found': '找不到 ZCode 可执行文件；请确认路径或在 PATH 上可用。',
  'zcode-workdir-invalid': '工作目录不可用，请重新选择工作区。',
  'zcode-workdir-escapes-workspace': 'ZCode 只能打开当前工作区内的目录。',
  'zcode-run-already-active': '该会话已在运行中。',
  'zcode-spawn-failed': 'ZCode 协议子进程启动失败；请确认可执行文件与工作目录。',
  'zcode-run-not-active': 'ZCode 会话已结束，请重新启动。',
  'zcode-frame-invalid': '协议帧格式无效（必须是非空单行，且不超过 1MB）。',
  'zcode-stdin-write-failed': '写入 ZCode 协议子进程失败；会话可能已退出。',
  'zcode-stop-failed': '停止 ZCode 会话失败；进程可能已退出。',
};

export function zcodeProcessErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? '');
  return errorTexts[code] ?? 'ZCode Agent 操作未完成。';
}

/** spawn `<executable> agent-server`；cwd 必须落在当前工作区内（原生侧强制）。 */
export async function startZcodeAgent(
  runId: string,
  executable: string,
  workingDirectory: string | undefined,
  deps: ZCodeProcessDeps = defaultDeps,
): Promise<void> {
  if (!nativeRuntime()) throw new Error('zcode-native-unavailable');
  await deps.invoke('start_zcode_agent', {
    request: { runId, executable, workingDirectory: workingDirectory ?? null },
  });
}

/** 写入一帧协议内容（不含行尾换行；原生侧补 `\n` 并做单行校验）。 */
export async function writeZcodeStdin(
  runId: string,
  line: string,
  deps: ZCodeProcessDeps = defaultDeps,
): Promise<void> {
  if (!nativeRuntime()) throw new Error('zcode-native-unavailable');
  await deps.invoke('zcode_write_stdin', { request: { runId, line } });
}

export async function stopZcodeAgent(
  runId: string,
  deps: ZCodeProcessDeps = defaultDeps,
): Promise<void> {
  if (!nativeRuntime()) return;
  await deps.invoke('stop_zcode_agent', { request: { runId } });
}

/**
 * 当前工作区根的绝对路径，仅供 ZCode Agent 会话握手（session/create）使用。
 * 路径只在本机内存流转：不落盘、不上传、不进诊断日志。
 */
export async function zcodeWorkspaceRoot(deps: ZCodeProcessDeps = defaultDeps): Promise<string> {
  if (!nativeRuntime()) throw new Error('zcode-native-unavailable');
  const root = await deps.invoke('zcode_workspace_root', {});
  return typeof root === 'string' ? root : '';
}

/** 订阅协议行事件（stdout=NDJSON 协议帧，stderr=诊断日志）与退出事件。 */
export async function subscribeZcodeProcess(
  handlers: {
    onLine(payload: ZCodeLinePayload): void;
    onExit(payload: ZCodeExitPayload): void;
  },
  deps: ZCodeProcessDeps = defaultDeps,
): Promise<() => void> {
  if (!nativeRuntime()) return () => undefined;
  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(await deps.listen(ZCODE_LINE_EVENT, (event) => {
    const payload = event.payload as Partial<ZCodeLinePayload> | null;
    if (payload && typeof payload.runId === 'string' && (payload.stream === 'stdout' || payload.stream === 'stderr') && typeof payload.text === 'string') {
      handlers.onLine({ runId: payload.runId, stream: payload.stream, text: payload.text });
    }
  }));
  unlisteners.push(await deps.listen(ZCODE_EXIT_EVENT, (event) => {
    const payload = event.payload as Partial<ZCodeExitPayload> | null;
    if (payload && typeof payload.runId === 'string') {
      handlers.onExit({ runId: payload.runId, code: typeof payload.code === 'number' ? payload.code : null });
    }
  }));
  return () => { for (const unlisten of unlisteners) unlisten(); };
}
