import { useCallback, useEffect, useState } from 'react';
import type { BrowserBackendStatus } from '../../runtime/cdp-browser-tool-handler';
import { listLiveBrowserSessions, liveSessionStatusLabel, type LiveBrowserSession } from '../../runtime/browser-session-live';
import { BrowserBackendCard } from './BrowserBackendCard';

/**
 * 浏览后端与会话。
 *
 * ## 这个面板以前是什么，为什么改
 *
 * 以前是"授权账本"：请求会话 → 授权 → 暂停 → 恢复 → 结束，外加审计事件流。
 * 那套东西的后端（`apps/runtime-gateway` 的 `/api/browser-sessions`）在 2026-08-26
 * 被整个删除，于是面板永远停在"未就绪"，按钮全是灰的。
 *
 * 现在改成展示**真实存在的东西**：浏览器工具在执行时附着的 CDP 会话。
 * 数据来自 `browser_sessions_list`，与工具面读的是同一份状态。
 *
 * 刻意**没有**保留旧的审批流程：真实实现里没有"请求/授权/暂停"这些状态，
 * 把旧概念硬套到新数据上，只会让界面继续描述一个不存在的流程。
 */

function useLiveSessions(): {
  readonly sessions: readonly LiveBrowserSession[];
  readonly error: string | undefined;
  readonly pending: boolean;
  readonly refresh: () => void;
} {
  const [sessions, setSessions] = useState<readonly LiveBrowserSession[]>([]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const refresh = useCallback((): void => {
    setPending(true);
    setError(undefined);
    void listLiveBrowserSessions()
      .then(setSessions)
      .catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : '无法读取浏览会话状态。');
      })
      .finally(() => setPending(false));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { sessions, error, pending, refresh };
}

export function BrowserSessionSummaryCard({ backend, onOpen }: {
  /** 浏览器**执行后端**的状态。 */
  readonly backend?: BrowserBackendStatus;
  readonly onOpen: () => void;
}) {
  const { sessions, pending, refresh } = useLiveSessions();
  const active = sessions.filter((session) => session.status === 'active').length;
  return <section className="browser-session-summary-card" aria-label="浏览会话摘要">
    <div className="browser-session-summary-header"><div><span className="panel-eyebrow">BROWSER SESSIONS</span><h2>浏览后端与会话</h2><p>浏览器工具在执行时附着到本机浏览器的调试端口；这里显示后端开关与当前附着的会话。面板本身不读页面内容。</p></div><button title="重新读取浏览后端状态与当前会话；不会启动浏览器或访问网页。" disabled={pending} onClick={refresh} type="button">{pending ? '读取中…' : '刷新'}</button></div>
    <div className="browser-session-summary-metrics"><div><span>后端</span><strong>{backend?.enabled ? '已启用' : '未启用'}</strong></div><div><span>可用会话</span><strong>{active}</strong></div><div><span>会话总数</span><strong>{sessions.length}</strong></div></div>
    <div className="browser-session-safety-note"><strong>面板只读状态</strong><span>不读页面、不读 cookie、不接管桌面。真正打开浏览器并执行动作的是模型通过浏览器工具发起的调用，且需要后端已启用。</span></div>
    <button className="browser-session-open" title="进入三级页面：开关后端并查看当前附着的会话。" onClick={onOpen} type="button">打开浏览会话控制 <span aria-hidden="true">→</span></button>
  </section>;
}

export function BrowserSessionControlPage({ onBack, backend, onToggleBackend }: {
  readonly onBack: () => void;
  readonly backend?: BrowserBackendStatus;
  /** 开关执行后端；返回被断开的会话数。 */
  readonly onToggleBackend: (enabled: boolean) => Promise<number>;
}) {
  const { sessions, error, pending, refresh } = useLiveSessions();
  return <section className="page-stack browser-session-control-page">
    <BrowserBackendCard backend={backend} onToggle={onToggleBackend} />
    <div className="page-heading browser-session-page-heading">
      <div><span>CAPABILITIES / BROWSER CONTROL</span><h1>浏览会话</h1><p>会话由浏览器工具在调用时创建与附着；这里只列出当前存在的会话及其目标标签页，不读取页面内容。</p></div>
      <div><button title="返回扩展与能力页面。" onClick={onBack} type="button">← 返回扩展与能力</button><button title="重新读取当前会话；不会启动浏览器或访问网页。" disabled={pending} onClick={refresh} type="button">{pending ? '读取中…' : '刷新'}</button></div>
    </div>
    <section className="browser-session-ledger">
      <div className="browser-session-ledger-heading"><div><span className="panel-eyebrow">LIVE SESSIONS</span><h2>当前附着的会话</h2><p>「执行中」表示正在跑一条命令，此时关闭后端会等它跑完再断开。</p></div><span>{sessions.length} 个</span></div>
      {sessions.length === 0
        ? <p className="browser-session-empty">当前没有活动的浏览会话。会话会在模型调用浏览器工具时自动创建。</p>
        : <div className="browser-session-list">{sessions.map((session) => <div className={`browser-session-item status-${session.status}`} key={session.sessionId}>
          <span className="browser-session-item-status">{liveSessionStatusLabel(session.status)}</span>
          <strong>{session.sessionId}</strong>
          <small>{session.targetId ? `目标 ${session.targetId}` : '目标不可读（正在执行命令）'}</small>
        </div>)}</div>}
    </section>
    <div className="browser-session-safety-note"><strong>这里没有页面内容</strong><span>会话状态只含 id 与目标标签页；页面正文、cookie 与凭据都不经过这个面板。</span></div>
    {error && <p className="browser-session-error" role="alert">{error}</p>}
  </section>;
}
