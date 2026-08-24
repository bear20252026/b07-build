import { useEffect, useMemo, useState } from 'react';
import { directUsageLedgerEntries, subscribeDirectUsageLedger, type DirectUsageLedgerEntry } from '../../runtime/direct-provider-usage-ledger';

interface UsageRow { readonly key: string; readonly provider: string; readonly model: string; readonly conversation: string; readonly calls: number; readonly failures: number; readonly averageLatency: number; readonly averageFirstByte?: number; readonly outputCharacters: number; }

function aggregate(entries: readonly DirectUsageLedgerEntry[]): readonly UsageRow[] {
  const rows = new Map<string, { provider: string; model: string; conversation: string; calls: number; failures: number; latency: number; firstByteTotal: number; firstByteCount: number; outputCharacters: number; }>();
  for (const entry of entries) {
    const key = `${entry.providerId}:${entry.model}:${entry.conversationId ?? '本地测试'}`;
    const row = rows.get(key) ?? { provider: entry.displayName, model: entry.model, conversation: entry.conversationId ?? '本地测试', calls: 0, failures: 0, latency: 0, firstByteTotal: 0, firstByteCount: 0, outputCharacters: 0 };
    row.calls += 1; row.failures += entry.outcome === 'failed' ? 1 : 0; row.latency += entry.elapsedMs; row.outputCharacters += entry.outputCharacters ?? 0;
    if (entry.firstByteMs !== undefined) { row.firstByteTotal += entry.firstByteMs; row.firstByteCount += 1; }
    rows.set(key, row);
  }
  return [...rows.entries()].map(([key, row]) => ({ key, provider: row.provider, model: row.model, conversation: row.conversation, calls: row.calls, failures: row.failures, averageLatency: Math.round(row.latency / row.calls), ...(row.firstByteCount ? { averageFirstByte: Math.round(row.firstByteTotal / row.firstByteCount) } : {}), outputCharacters: row.outputCharacters })).sort((left, right) => right.calls - left.calls);
}

export function DirectUsageLedgerPanel() {
  const [entries, setEntries] = useState<readonly DirectUsageLedgerEntry[]>(directUsageLedgerEntries);
  useEffect(() => subscribeDirectUsageLedger(() => setEntries(directUsageLedgerEntries())), []);
  const rows = useMemo(() => aggregate(entries), [entries]);
  const totalCalls = entries.length; const totalFailures = entries.filter((entry) => entry.outcome === 'failed').length;
  return <section className="direct-usage-ledger" aria-label="本地调用量账本">
    <div className="direct-usage-heading"><div><span>DIRECT PROVIDER LEDGER</span><h2>本地调用量与运行账本</h2><p>从当前 Windows WebView 的无敏感直连调用元数据聚合，并仅在本机保留最多 128 条。它不读取或存储聊天正文、图片、密钥、端点、供应商账单或 token/价格。</p></div></div>
    <div className="direct-usage-summary"><article><span>已记录操作</span><strong>{totalCalls}</strong><small>配置、测试、流式与聊天</small></article><article><span>失败操作</span><strong>{totalFailures}</strong><small>按本地错误类别归档</small></article><article><span>可见输出</span><strong>{entries.reduce((total, entry) => total + (entry.outputCharacters ?? 0), 0).toLocaleString()}</strong><small>字符；不是 token 或费用</small></article></div>
    <div className="direct-usage-rows">{rows.length === 0 ? <p>尚无本会话诊断记录。测试连接、流式测试或发送聊天后会在本机产生脱敏账本条目。</p> : rows.map((row) => <article key={row.key}><div><span>{row.provider}</span><strong>{row.model}</strong><small>{row.conversation}</small></div><dl><div><dt>调用</dt><dd>{row.calls}</dd></div><div><dt>平均耗时</dt><dd>{row.averageLatency.toLocaleString()} ms</dd></div><div><dt>首 token</dt><dd>{row.averageFirstByte === undefined ? '—' : `${row.averageFirstByte.toLocaleString()} ms`}</dd></div><div><dt>失败</dt><dd>{row.failures}</dd></div><div><dt>可见输出</dt><dd>{row.outputCharacters.toLocaleString()} 字符</dd></div></dl></article>)}</div>
  </section>;
}
