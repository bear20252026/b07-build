import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGitHubCollaborationIntent } from '../src/runtime/github-collaboration-intent.js';

test('仅明确 /github 命令会打开本地 GitHub 协作窗口', () => {
  assert.equal(resolveGitHubCollaborationIntent('/github')?.kind, 'open-github-collaboration');
  assert.equal(resolveGitHubCollaborationIntent('/github 准备上传当前项目')?.kind, 'open-github-collaboration');
  assert.equal(resolveGitHubCollaborationIntent('请帮我上传代码'), undefined);
  assert.equal(resolveGitHubCollaborationIntent('/git'), undefined);
});
