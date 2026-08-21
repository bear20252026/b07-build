import { useEffect, useMemo, useState } from 'react';
import { HttpBrowserSessionClient, type WorkbenchBrowserSession, type WorkbenchBrowserSessionEvent } from '../../runtime/browser-session-client';

const client = new HttpBrowserSessionClient();
const OPERATOR_ID = 'local.operator';

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function statusLabel(status: WorkbenchBrowserSession['status']): string {
  return ({ requested: '待授权', authorized: '已授权（仅记录）', paused: '已暂停', ended: '已结束', failed: '已失败' })[status];
}

function sessionActionLabel(type: WorkbenchBrowserSessionEvent['type']): string {
  return ({ requested: '创建请求', authorized: '显式授权', paused: '已暂停', resumed: '恢复授权', ended: '已结束', failed: '标记失败' })[type];
}

function useBrowserSessions(enabled: boolean) {
  const [sessions, setSessions] = useState<readonly WorkbenchBrowserSession[]>([]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const refresh = (): void => {
    if (!enabled || pending) return;
    setPending(true); setError(undefined);
    void client.list().then(setSessions).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取浏览会话账本。')).finally(() => setPending(false));
  };
  useEffect(() => { refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return { sessions, error, pending, refresh, setError, setPending, setSessions };
}

export function BrowserSessionSummaryCard({ gatewayAttached, onOpen }: { gatewayAttached: boolean; onOpen: () => void }) {
  const { sessions, error, pending, refresh } = useBrowserSessions(gatewayAttached);
  const counts = useMemo(() => ({ active: sessions.filter((item) => item.status === 'authorized').length, paused: sessions.filter((item) => item.status === 'paused').length, total: sessions.length }), [sessions]);
  return <section className="browser-session-summary-card" aria-label="浏览会话控制摘要">
    <div className="browser-session-summary-header"><div><span className="panel-eyebrow">BROWSER SESSION CONTROL</span><h2>浏览会话控制面</h2><p>记录目标主机、明确授权、暂停与结束；首轮不打开浏览器、不读取页面或 cookie，也不接管桌面。</p></div><button title="读取本机 Gateway 的脱敏浏览会话账本；不会启动浏览器或访问网页。" disabled={!gatewayAttached || pending} onClick={refresh} type="button">{pending ? '读取中…' : '刷新摘要'}</button></div>
    {!gatewayAttached && <p className="browser-session-inline-note">请先附着本机 Gateway。工作区首页不会显示或创建浏览会话。</p>}
    {gatewayAttached && <div className="browser-session-summary-metrics"><div><span>已授权</span><strong>{counts.active}</strong></div><div><span>已暂停</span><strong>{counts.paused}</strong></div><div><span>会话总数</span><strong>{counts.total}</strong></div></div>}
    <div className="browser-session-safety-note"><strong>执行能力：关闭</strong><span>本轮只提供可审查的会话状态机；网页点击、登录、上传、下载、支付与鼠标键盘控制均未实现。</span></div>
    {error && <p className="browser-session-error" role="alert">{error}</p>}
    <button className="browser-session-open" title="进入三级浏览会话页面，显式创建或改变会话状态，并查看脱敏审计事件。" disabled={!gatewayAttached} onClick={onOpen} type="button">打开浏览会话控制 <span aria-hidden="true">→</span></button>
  </section>;
}

export function BrowserSessionControlPage({ gatewayAttached, onBack }: { gatewayAttached: boolean; onBack: () => void }) {
  const { sessions, error, pending, refresh, setError, setPending, setSessions } = useBrowserSessions(gatewayAttached);
  const [targetUrl, setTargetUrl] = useState('');
  const [reason, setReason] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [events, setEvents] = useState<readonly WorkbenchBrowserSessionEvent[]>([]);
  const [auditPending, setAuditPending] = useState(false);
  const selected = sessions.find((item) => item.sessionId === selectedSessionId);

  const reload = (selectId?: string): void => {
    if (!gatewayAttached) return;
    setPending(true); setError(undefined);
    void client.list().then((next) => { setSessions(next); if (selectId) setSelectedSessionId(selectId); }).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取浏览会话账本。')).finally(() => setPending(false));
  };
  const openAudit = (sessionId: string): void => {
    if (!gatewayAttached || auditPending) return;
    setSelectedSessionId(sessionId); setAuditPending(true); setError(undefined);
    void client.events(sessionId).then(setEvents).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取浏览会话审计。')).finally(() => setAuditPending(false));
  };
  const create = (): void => {
    if (!gatewayAttached || pending) return;
    setPending(true); setError(undefined);
    void client.create({ by: OPERATOR_ID, targetUrl, reason }).then((next) => { setTargetUrl(''); setReason(''); reload(next.sessionId); }).catch((nextError: unknown) => { setError(nextError instanceof Error ? nextError.message : '浏览会话创建失败。'); setPending(false); });
  };
  const transition = (action: 'authorize' | 'pause' | 'resume' | 'end'): void => {
    if (!selected || pending) return;
    setPending(true); setError(undefined);
    void client.transition(selected.sessionId, action, { by: OPERATOR_ID, reason: `${action} from Workbench` }).then((next) => { reload(next.sessionId); openAudit(next.sessionId); }).catch((nextError: unknown) => { setError(nextError instanceof Error ? nextError.message : '浏览会话状态未更新。'); setPending(false); });
  };

  return <section className="page-stack browser-session-control-page"><div className="page-heading browser-session-page-heading"><div><span>CAPABILITIES / BROWSER CONTROL</span><h1>浏览会话控制</h1><p>三级控制页。会话只保存公网 HTTPS 主机与哈希化范围；没有完整 URL、页面内容、cookie、密码、API key 或浏览器/桌面执行能力。</p></div><div><button title="返回二级扩展与能力页面。" onClick={onBack} type="button">← 返回扩展与能力</button><button title="重新读取本机 Gateway 的脱敏会话和状态；不会启动浏览器或访问网页。" disabled={!gatewayAttached || pending} onClick={refresh} type="button">{pending ? '读取中…' : '刷新'}</button></div></div>
    {!gatewayAttached && <p className="browser-session-inline-note">请先附着本机 Gateway 后使用浏览会话控制面。</p>}
    {gatewayAttached && <><section className="browser-session-create"><div><span className="panel-eyebrow">EXPLICIT REQUEST</span><h2>请求一个受控浏览会话</h2><p>此操作仅创建本机审计记录。即使随后授权，也不会自动启动浏览器、读取网页或执行页面动作。</p></div><label>公网 HTTPS 目标<input aria-label="浏览会话目标 HTTPS 地址" autoComplete="off" inputMode="url" onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://docs.example.com" value={targetUrl} /></label><label>原因（可选）<input aria-label="浏览会话创建原因" maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="例如：仅审查公开文档的会话范围" value={reason} /></label><button className="browser-session-create-button" disabled={!targetUrl.trim() || pending} onClick={create} title="明确创建一个仅记录的浏览会话请求；不会打开或控制浏览器。" type="button">{pending ? '提交中…' : '创建请求'}</button></section>
      <section className="browser-session-ledger"><div className="browser-session-ledger-heading"><div><span className="panel-eyebrow">REDACTED LEDGER</span><h2>本机浏览会话</h2><p>选择会话后查看审计；按钮只会发送明确的状态意图，不包含网页操作。</p></div><span>{sessions.length} 条</span></div>{sessions.length === 0 ? <p className="browser-session-empty">尚无浏览会话。请先显式创建一条只记录状态的请求。</p> : <div className="browser-session-list">{sessions.map((item) => <button aria-pressed={item.sessionId === selectedSessionId} className={`browser-session-item status-${item.status}${item.sessionId === selectedSessionId ? ' selected' : ''}`} key={item.sessionId} onClick={() => openAudit(item.sessionId)} title="查看该会话的脱敏状态和审计事件；不会发起网页访问。" type="button"><span className="browser-session-item-status">{statusLabel(item.status)}</span><strong>{item.targetHost}</strong><small>r{item.revision} · {formatTime(item.updatedAt)} · 执行关闭</small></button>)}</div>}</section>
      <section className="browser-session-detail" aria-live="polite">{!selected ? <div className="browser-session-empty"><strong>选择一条会话</strong><span>右侧审计会展示谁在何时创建、授权、暂停、恢复或结束了本机记录。</span></div> : <><div className="browser-session-detail-heading"><div><span className="panel-eyebrow">SESSION AUDIT</span><h2>{selected.targetHost}</h2><p>{statusLabel(selected.status)} · 范围摘要 {selected.scopeDigest.slice(0, 12)}… · 无执行能力</p></div><span className={`browser-session-status status-${selected.status}`}>{statusLabel(selected.status)}</span></div><div className="browser-session-actions">{selected.status === 'requested' && <button className="browser-session-authorize" disabled={pending} onClick={() => transition('authorize')} title="明确授权会话状态，但不会启动浏览器或执行网页动作。" type="button">授权（仅记录）</button>}{selected.status === 'authorized' && <button className="browser-session-pause" disabled={pending} onClick={() => transition('pause')} title="暂停该会话状态；这不会终止任何浏览器，因为首轮没有浏览器执行。" type="button">暂停</button>}{selected.status === 'paused' && <button className="browser-session-resume" disabled={pending} onClick={() => transition('resume')} title="恢复会话状态；仍然不会启动浏览器或执行网页动作。" type="button">恢复（仅记录）</button>}{!['ended', 'failed'].includes(selected.status) && <button className="browser-session-end" disabled={pending} onClick={() => transition('end')} title="结束该会话状态。结束后不会再可恢复。" type="button">结束会话</button>}</div><div className="browser-session-safety-note"><strong>浏览器与桌面控制：关闭</strong><span>canExecute、页面读取、浏览器秘密读取和桌面控制均固定为 false。</span></div><div className="browser-session-events"><h3>审计事件</h3>{auditPending && <p>正在读取本机审计事件…</p>}{!auditPending && events.length === 0 && <p>尚未读取审计事件。选择会话以加载。</p>}{events.map((event) => <article key={event.eventId}><span>{formatTime(event.at)}</span><strong>{sessionActionLabel(event.type)}</strong><small>{event.by} · r{event.revision} · 执行关闭{event.reason ? ` · ${event.reason}` : ''}</small></article>)}</div></>}</section>
      {error && <p className="browser-session-error" role="alert">{error}</p>}
    </>}
  </section>;
}
