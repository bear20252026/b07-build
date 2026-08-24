import { useEffect, useMemo, useState } from 'react';
import { sessionPerformanceEntries, subscribeSessionPerformance, type SessionPerformanceEntry } from '../../runtime/session-performance-ledger';
import { sessionPerformanceHealth } from '../../runtime/session-performance-health';

function average(entries: readonly SessionPerformanceEntry[], kind: SessionPerformanceEntry['kind']): string {
  const samples = entries.filter((entry) => entry.kind === kind);
  return samples.length ? `${Math.round(samples.reduce((total, entry) => total + entry.elapsedMs, 0) / samples.length).toLocaleString()} ms` : '—';
}

export function SessionPerformancePanel() {
  const [entries, setEntries] = useState<readonly SessionPerformanceEntry[]>(sessionPerformanceEntries);
  useEffect(() => subscribeSessionPerformance(() => setEntries(sessionPerformanceEntries())), []);
  const latest = entries[0];
  const visibleWindow = useMemo(() => entries.filter((entry) => entry.kind === 'timeline-frame' && entry.renderedMessageCount !== undefined).at(0), [entries]);
  const health = useMemo(() => sessionPerformanceHealth(entries), [entries]);
  return <section className="direct-usage-ledger" aria-label="本地会话性能观察">
    <div className="direct-usage-heading"><div><span>LOCAL SESSION OBSERVATION</span><h2>长会话与性能观察</h2><p>仅保留本机 128 条数值型观察：会话持久化、50 ms 流式刷新调度与时间线下一帧响应。不会读取或保存提示词、回复、图片、密钥、模型、Base URL、代理、文件名或工作区路径；这些指标不是供应商 token、费用或账单。</p></div></div>
    <div className="direct-usage-summary"><article><span>本地样本</span><strong>{entries.length}</strong><small>有界本地元数据</small></article><article><span>持久化平均</span><strong>{average(entries, 'conversation-persist')}</strong><small>WebView localStorage 写入</small></article><article><span>流式刷新平均</span><strong>{average(entries, 'stream-refresh')}</strong><small>React 状态调度，不是网络延迟</small></article></div>
    <div className="direct-usage-rows">{health.map((item) => <article key={item.kind}><div><span>{item.state === 'stable' ? '本机稳定' : item.state === 'attention' ? '需要关注' : '等待样本'}</span><strong>{item.label}</strong><small>{item.detail}</small></div><dl><div><dt>样本</dt><dd>{item.samples}</dd></div><div><dt>近期平均</dt><dd>{item.averageMs === undefined ? '—' : `${item.averageMs.toLocaleString()} ms`}</dd></div></dl></article>)}</div>
    <div className="direct-usage-rows">{entries.length === 0 ? <p>尚无本地性能样本。发送聊天、接收流式文本或切换长会话时才会生成脱敏数值观察。</p> : <article><div><span>当前窗口</span><strong>{visibleWindow?.renderedMessageCount ?? 0} / {visibleWindow?.messageCount ?? latest?.messageCount ?? 0} 条消息</strong><small>仅渲染可见尾部窗口；更早消息需由主人显式加载。</small></div><dl><div><dt>时间线帧</dt><dd>{average(entries, 'timeline-frame')}</dd></div><div><dt>最近持久化</dt><dd>{latest?.kind === 'conversation-persist' ? `${latest.elapsedMs.toLocaleString()} ms` : '—'}</dd></div><div><dt>最近样本</dt><dd>{latest ? new Date(latest.at).toLocaleTimeString() : '—'}</dd></div></dl></article>}</div>
  </section>;
}
