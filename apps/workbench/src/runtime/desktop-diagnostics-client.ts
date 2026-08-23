import { invoke } from '@tauri-apps/api/core';
import type { SearxngDiagnosticStatus } from './provider-diagnostics';

export interface DesktopDiagnosticsSnapshot {
  readonly schemaVersion: 1;
  readonly desktopVersion: string;
  readonly sourceRevision: string;
  readonly workspaceSelected: boolean;
  readonly connectedProviderCount: number;
  readonly searxng: SearxngDiagnosticStatus;
}

function validSearxng(value: unknown): value is SearxngDiagnosticStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<SearxngDiagnosticStatus>;
  return status.schemaVersion === 1 && (status.state === 'not-started' || status.state === 'running') && typeof status.startupTimeoutSeconds === 'number' && typeof status.requestTimeoutSeconds === 'number' && (status.port === undefined || (Number.isInteger(status.port) && status.port > 0 && status.port < 65_536));
}

export function desktopDiagnosticsFrom(value: unknown): DesktopDiagnosticsSnapshot {
  if (!value || typeof value !== 'object') throw new Error('desktop-diagnostics-invalid');
  const snapshot = value as Partial<DesktopDiagnosticsSnapshot>;
  const connectedProviderCount = snapshot.connectedProviderCount;
  if (snapshot.schemaVersion !== 1 || typeof snapshot.desktopVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(snapshot.desktopVersion) || typeof snapshot.sourceRevision !== 'string' || !/^(?:[a-f0-9]{40}|unavailable)$/i.test(snapshot.sourceRevision) || typeof snapshot.workspaceSelected !== 'boolean' || typeof connectedProviderCount !== 'number' || !Number.isInteger(connectedProviderCount) || connectedProviderCount < 0 || !validSearxng(snapshot.searxng)) throw new Error('desktop-diagnostics-invalid');
  return { schemaVersion: 1, desktopVersion: snapshot.desktopVersion, sourceRevision: snapshot.sourceRevision, workspaceSelected: snapshot.workspaceSelected, connectedProviderCount, searxng: snapshot.searxng };
}

export const desktopDiagnosticsClient = Object.freeze({
  async read(): Promise<DesktopDiagnosticsSnapshot> { return desktopDiagnosticsFrom(await invoke('desktop_diagnostics')); },
});
