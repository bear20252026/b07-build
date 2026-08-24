import { useEffect, useState } from 'react';
import { githubCollaborationClient, type GithubIdentity, type GithubWorkspacePreflight, type GithubWorkspaceStatus } from '../../runtime/github-collaboration-client';
import { loadGithubCollaborationPreferences, saveGithubCollaborationPreferences } from '../../runtime/github-collaboration-preferences';

function errorText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? '');
  const messages: Record<string, string> = {
    'github-workspace-not-selected': '请先在“工作区与文件”中选择一个 Git 仓库目录。',
    'github-token-invalid': 'GitHub 个人访问令牌格式无效。',
    'github-token-rejected': 'GitHub 未接受该个人访问令牌。',
    'github-no-local-changes': '当前工作区没有可提交的本地变更。',
    'github-push-requires-confirmation': '请勾选确认后再提交并推送。',
    'github-git-push-failed': '本地提交已完成，但推送失败；请检查仓库远程地址、令牌权限和网络。',
  };
  return messages[code] ?? 'GitHub 协作操作未完成。';
}

export function GitHubCollaborationPanel() {
  const [token, setToken] = useState(() => loadGithubCollaborationPreferences().token);
  const [identity, setIdentity] = useState<GithubIdentity>();
  const [status, setStatus] = useState<GithubWorkspaceStatus>();
  const [preflight, setPreflight] = useState<GithubWorkspacePreflight>();
  const [message, setMessage] = useState('chore: update AI Work OS workspace');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const refreshStatus = (): void => { setPending(true); setError(undefined); void githubCollaborationClient.status().then(setStatus).catch((next: unknown) => setError(errorText(next))).finally(() => setPending(false)); };
  useEffect(refreshStatus, []);
  const test = (): void => { setPending(true); setError(undefined); saveGithubCollaborationPreferences({ schemaVersion: 1, token }); void githubCollaborationClient.testToken(token).then(setIdentity).catch((next: unknown) => setError(errorText(next))).finally(() => setPending(false)); };
  const push = (): void => { setPending(true); setError(undefined); saveGithubCollaborationPreferences({ schemaVersion: 1, token }); void githubCollaborationClient.commitAndPush(token, message, confirmed).then((next) => { setStatus(next); setConfirmed(false); }).catch((next: unknown) => setError(errorText(next))).finally(() => setPending(false)); };
  const runPreflight = (): void => { setPending(true); setError(undefined); void githubCollaborationClient.preflight().then(setPreflight).catch((next: unknown) => setError(errorText(next))).finally(() => setPending(false)); };
  return <section className="github-collaboration-panel" aria-label="GitHub 代码协作">
    <div className="github-collaboration-heading"><div><span>GITHUB COLLABORATION</span><h2>本地变更 · 明确提交 · 确认推送</h2><p>令牌只保存在当前 Windows 用户的本地应用数据中；不会进入聊天、模型请求、日志、Git 远程地址或发布清单。</p></div><button disabled={pending} onClick={refreshStatus} type="button">刷新变更</button></div>
    {error && <p className="github-collaboration-error" role="alert">{error}</p>}
    <label>GitHub 个人访问令牌<input autoComplete="off" onChange={(event) => setToken(event.target.value)} placeholder="github_pat_… 或 ghp_…" type="password" value={token} /></label>
    <div className="github-collaboration-row"><button disabled={pending || !token.trim()} onClick={test} type="button">测试令牌</button>{identity && <span>已连接：{identity.name ?? identity.login}（{identity.login}）</span>}</div>
    <div className="github-status"><strong>当前工作区</strong><span>分支：{status?.branch || '未读取'}</span><pre>{status?.changes || '没有未提交变更，或尚未选择 Git 工作区。'}</pre>{status?.diffStat && <pre>{status.diffStat}</pre>}</div>
    <section className="github-preflight"><div><span>TEST SUMMARY · EXPLICIT</span><strong>{preflight ? preflight.passed ? '变更预检通过' : '变更预检发现问题' : '尚未运行预检'}</strong><p>仅在点击后执行固定的 <code>git diff --check</code>；不会执行项目脚本、安装依赖、调用模型或读取 PAT。</p></div><button disabled={pending} onClick={runPreflight} type="button">运行变更预检</button>{preflight && <pre>{preflight.detail}</pre>}</section>
    <label>提交说明<input maxLength={240} onChange={(event) => setMessage(event.target.value)} value={message} /></label>
    <label className="github-confirm"><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />我已查看本地变更，并确认现在创建 Git 提交并推送到此工作区的 <code>origin</code> 远程仓库。</label>
    <button className="github-push" disabled={pending || !token.trim() || !message.trim() || !confirmed} onClick={push} type="button">{pending ? '正在处理…' : '提交并推送到 GitHub'}</button>
  </section>;
}
