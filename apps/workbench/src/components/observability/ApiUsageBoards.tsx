import { useEffect, useMemo, useState } from 'react';
import { HttpApiUsageClient, type WorkbenchApiUsageReceipt, type WorkbenchApiUsageSummary } from '../../runtime/api-usage-client';

const client = new HttpApiUsageClient();

function formatTime(value: number | undefined): string {
  return value === undefined ? '尚无已记录调用' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function formatLatency(total: number, calls: number): string {
  return calls > 0 ? `${Math.round(total / calls).toLocaleString()} ms / 次` : '—';
}

function useApiUsage(enabled: boolean, includeReceipts: boolean) {
  const [summary, setSummary] = useState<WorkbenchApiUsageSummary>();
  const [receipts, setReceipts] = useState<readonly WorkbenchApiUsageReceipt[]>([]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const refresh = (): void => {
    if (!enabled || pending) return;
    setPending(true); setError(undefined);
    const summaryRequest = client.summary();
    const receiptsRequest = includeReceipts ? client.receipts(200) : Promise.resolve<readonly WorkbenchApiUsageReceipt[]>([]);
    void Promise.all([summaryRequest, receiptsRequest]).then(([nextSummary, nextReceipts]) => { setSummary(nextSummary); setReceipts(nextReceipts); }).catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取 API 使用记录。')).finally(() => setPending(false));
  };
  useEffect(() => { refresh(); // 仅在显式进入相应二/三级页面且 本机能力服务 已附着时拉取。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, includeReceipts]);
  return { summary, receipts, error, pending, refresh };
}

export function ApiUsageSummaryCard({ localServiceReady, onOpen }: { localServiceReady: boolean; onOpen: () => void }) {
  const { summary, error, pending, refresh } = useApiUsage(localServiceReady, false);
  return <section className="api-usage-summary-card" aria-label="API 使用摘要">
    <div className="api-usage-summary-header"><div><span className="panel-eyebrow">LOCAL API USAGE</span><h2>第三方 API 使用摘要</h2><p>仅统计本机 本机能力服务 已完成的受控推理调用，不读取供应商账户账单。</p></div><button title="读取当前本机 本机能力服务 的只读使用摘要；不会请求模型、价格或供应商账户。" disabled={!localServiceReady || pending} onClick={refresh} type="button">{pending ? '读取中…' : '刷新摘要'}</button></div>
    {!localServiceReady && <p className="api-usage-inline-note">请先附着本机 本机能力服务。首页不会显示 API 使用数据。</p>}
    {localServiceReady && !error && <div className="api-usage-summary-metrics"><div><span>完成调用</span><strong>{summary?.totalCalls ?? '—'}</strong></div><div><span>平均延迟</span><strong>{summary ? formatLatency(summary.totalLatencyMs, summary.totalCalls) : '—'}</strong></div><div><span>最近活动</span><strong>{formatTime(summary?.latestRecordedAt)}</strong></div></div>}
    {localServiceReady && <div className="api-usage-unknown"><strong>Token 与成本：未报告</strong><span>当前 Driver 未统一提供供应商 billing usage，因此不会把字符数或本地估算伪装为 token 或账单。</span></div>}
    {error && <p className="api-usage-error" role="alert">{error}</p>}
    <button className="api-usage-open" title="进入三级 API 使用审计页，查看 Provider、模型聚合和单次脱敏收据。" disabled={!localServiceReady} onClick={onOpen} type="button">查看 API 使用审计 <span aria-hidden="true">→</span></button>
  </section>;
}

export function ApiUsageAuditPage({ localServiceReady, onBack }: { localServiceReady: boolean; onBack: () => void }) {
  const { summary, receipts, error, pending, refresh } = useApiUsage(localServiceReady, true);
  const [provider, setProvider] = useState('all');
  const [model, setModel] = useState('all');
  const providers = useMemo(() => [...new Set((summary?.models ?? []).map((item) => item.providerId))].sort(), [summary]);
  const models = useMemo(() => [...new Set((summary?.models ?? []).filter((item) => provider === 'all' || item.providerId === provider).map((item) => item.model))].sort(), [summary, provider]);
  const filteredModels = (summary?.models ?? []).filter((item) => (provider === 'all' || item.providerId === provider) && (model === 'all' || item.model === model));
  const filteredReceipts = receipts.filter((item) => (provider === 'all' || item.providerId === provider) && (model === 'all' || item.model === model));
  return <section className="page-stack api-usage-audit-page"><div className="page-heading api-usage-page-heading"><div><span>RUN RECORDS / API USAGE</span><h1>API 使用审计</h1><p>三级只读页面。按 Provider 与模型查看 本机能力服务 已完成的调用收据；没有 prompt、输出、API key、端点、真实账单或自动刷新价格。</p></div><div><button title="返回二级运行记录页面。" onClick={onBack} type="button">← 返回运行记录</button><button title="重新读取本机 本机能力服务 的只读用量投影；不会调用任何第三方 API。" disabled={!localServiceReady || pending} onClick={refresh} type="button">{pending ? '读取中…' : '刷新'}</button></div></div>
    {!localServiceReady && <p className="api-usage-inline-note">请先附着本机 本机能力服务 后查看本机使用账本。</p>}
    {localServiceReady && <><div className="api-usage-filters"><label>Provider<select title="筛选本机收据，不会切换或调用 Provider。" value={provider} onChange={(event) => { setProvider(event.target.value); setModel('all'); }}><option value="all">全部 Provider</option>{providers.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>模型<select title="筛选本机收据，不会切换或调用模型。" value={model} onChange={(event) => setModel(event.target.value)}><option value="all">全部模型</option>{models.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><span>仅已完成调用 · token/cost 未报告</span></div>
      <div className="api-usage-model-grid">{filteredModels.length === 0 && <p className="api-usage-empty">尚无符合条件的已完成调用。请在“已连接模型”页显式发送一次受限文本请求后再返回查看。</p>}{filteredModels.map((item) => <article key={`${item.providerId}:${item.model}`}><span>{item.providerId}</span><strong>{item.model}</strong><div><b>{item.callCount}</b><small>完成调用</small></div><p>平均 {formatLatency(item.totalLatencyMs, item.callCount)} · 输出 {item.totalOutputCharacters.toLocaleString()} 字符</p><em>供应商 token 未报告；成本未配置</em></article>)}</div>
      {error && <p className="api-usage-error" role="alert">{error}</p>}
      <section className="api-usage-receipts"><div><span className="panel-eyebrow">REDACTED RECEIPTS</span><h2>单次调用收据</h2><p>仅显示身份、模型、时间、延迟和输出字符数；没有请求或响应内容。</p></div>{filteredReceipts.length === 0 ? <p className="api-usage-empty">尚无脱敏收据。</p> : <div className="api-usage-receipt-list">{filteredReceipts.map((item) => <article key={item.usageId}><span>{formatTime(item.recordedAt)}</span><strong>{item.providerId} · {item.model}</strong><small>{item.latencyMs.toLocaleString()} ms · {item.outputCharacters.toLocaleString()} 输出字符 · Profile r{item.profileRevision}</small><em>Token 未报告 · 未记录输入/输出/端点</em></article>)}</div>}</section>
    </>}
  </section>;
}
