import { invoke } from '@tauri-apps/api/core';

export interface ProjectMemorySnapshot {
  readonly selected: boolean;
  readonly fileName: string;
  readonly content: string;
}

export const projectMemoryClient = Object.freeze({
  read: (): Promise<ProjectMemorySnapshot> => invoke('read_project_memory'),
  write: (content: string): Promise<ProjectMemorySnapshot> => invoke('write_project_memory', { content }),
});
