export interface GitHubCollaborationIntent {
  readonly kind: 'open-github-collaboration';
  readonly acknowledgement: string;
}

/** 仅解析明确保留命令；不猜测自然语言，更不会把令牌传入聊天或 Provider。 */
export function resolveGitHubCollaborationIntent(value: string): GitHubCollaborationIntent | undefined {
  const normalized = value.trim();
  if (!/^\/github(?:\s+.*)?$/i.test(normalized)) return undefined;
  return {
    kind: 'open-github-collaboration',
    acknowledgement: '已打开 GitHub 协作窗口。请先查看本地变更；提交和推送仍需在该窗口中勾选确认。',
  };
}
