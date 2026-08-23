import { invoke } from '@tauri-apps/api/core';

export interface GithubIdentity { readonly login: string; readonly name?: string; }
export interface GithubWorkspaceStatus { readonly selected: boolean; readonly branch: string; readonly changes: string; readonly diffStat: string; }

export const githubCollaborationClient = Object.freeze({
  testToken: (token: string): Promise<GithubIdentity> => invoke('github_test_token', { token }),
  status: (): Promise<GithubWorkspaceStatus> => invoke('github_workspace_status'),
  commitAndPush: (token: string, message: string, confirmed: boolean): Promise<GithubWorkspaceStatus> => invoke('github_commit_and_push', { token, message, confirmed }),
});
