import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface TerminalOutputEvent { readonly runId: string; readonly stream: 'stdout' | 'stderr'; readonly text: string; }
export interface TerminalDoneEvent { readonly runId: string; readonly exitCode?: number; readonly cancelled: boolean; readonly error?: string; }

function runId(): string { return `terminal-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`; }

export async function startTerminalCommand(command: string, confirmDangerous: boolean, onOutput: (event: TerminalOutputEvent) => void, onDone: (event: TerminalDoneEvent) => void): Promise<{ runId: string; dispose(): void }> {
  const id = runId();
  let outputListener: UnlistenFn | undefined;
  let doneListener: UnlistenFn | undefined;
  const dispose = (): void => { outputListener?.(); doneListener?.(); };
  try {
    outputListener = await listen<TerminalOutputEvent>('terminal-command-output', (event) => { if (event.payload?.runId === id) onOutput(event.payload); });
    doneListener = await listen<TerminalDoneEvent>('terminal-command-done', (event) => { if (event.payload?.runId === id) { onDone(event.payload); dispose(); } });
    await invoke('start_terminal_command', { request: { runId: id, command, confirmDangerous } });
    return { runId: id, dispose };
  } catch (error) { dispose(); throw error; }
}

export async function cancelTerminalCommand(runId: string): Promise<void> { await invoke('cancel_terminal_command', { request: { runId } }); }
