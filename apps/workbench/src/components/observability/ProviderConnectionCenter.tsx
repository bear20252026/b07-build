import { useState } from 'react';
import './ProviderConnectionCenter.css';
import type { WorkbenchProviderConnection, WorkbenchProviderConnectionProbe, WorkbenchProviderInference, WorkbenchProviderModelDiscovery } from '../../runtime/task-client';
import type { WorkbenchProviderStreamingOutput } from '../../runtime/use-provider-control-plane';

export interface ProviderConnectionCenterProps {
  connections?: readonly WorkbenchProviderConnection[];
  probes: Readonly<Record<string, WorkbenchProviderConnectionProbe | undefined>>;
  inferences: Readonly<Record<string, WorkbenchProviderInference | undefined>>;
  discoveredModels: Readonly<Record<string, WorkbenchProviderModelDiscovery | undefined>>;
  taskModelSelection?: Readonly<{ providerId: string; model?: string }>;
  streaming: Readonly<Record<string, WorkbenchProviderStreamingOutput | undefined>>;
  error?: string;
  pendingProviderId?: string;
  onRefresh(): void;
  onProbe(providerId: string): void;
  onDiscoverModels(providerId: string): void;
  onSelectTaskModel(selection: Readonly<{ providerId: string; model?: string }>): void;
  onInfer(providerId: string, prompt: string, model?: string): void;
  onStream(providerId: string, prompt: string, model?: string): void;
}

function probeLabel(probe: WorkbenchProviderConnectionProbe | undefined): string | undefined {
  if (!probe) return undefined;
  const labels: Record<WorkbenchProviderConnectionProbe['outcome'], string> = {
    reachable: '连接可达', 'missing-credential': '未发现连接信息', 'not-registered': '尚未连接', 'not-active': '尚未连接', rejected: '认证、配额或账户策略拒绝', unreachable: '网络不可达、地址错误或超时',
  };
  return probe.latencyMs === undefined ? labels[probe.outcome] : `${labels[probe.outcome]} · ${probe.latencyMs} ms`;
}

/** 所有连接均为 Tauri 原生进程直连的 Provider 会话；预置与自定义服务共享同一操作路径。 */
export function ProviderConnectionCenter({ connections, probes, inferences, streaming, discoveredModels, taskModelSelection, error, pendingProviderId, onRefresh, onProbe, onDiscoverModels, onSelectTaskModel, onInfer, onStream }: ProviderConnectionCenterProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [models, setModels] = useState<Readonly<Record<string, string>>>({});
  return (
    <section className="provider-connection-center" aria-label="Commercial model provider connections">
      <div className="provider-connection-heading">
        <div>
          <div className="panel-eyebrow">DIRECT PROVIDER CONNECTIONS</div>
          <h2>已连接模型</h2>
          <p>预置与自定义服务完全使用同一条桌面直连路径：填写地址、密钥与模型后即可查询、选择并流式对话。</p>
        </div>
        <button className="panel-refresh-button" title="刷新当前桌面会话内的连接列表；不会发起网络请求。" type="button" onClick={onRefresh}>刷新状态</button>
      </div>
      {error && <p className="provider-connection-error" role="alert">{error}</p>}
      {!connections && <p className="provider-connection-empty">正在读取当前桌面会话的模型连接…</p>}
      {connections?.length === 0 && <p className="provider-connection-empty">尚未连接模型。请先在“API 连接”填写任意预置或自定义兼容服务。</p>}
      {connections?.map((connection) => {
        const pending = pendingProviderId === connection.providerId;
        const probe = probes[connection.providerId];
        const draft = drafts[connection.providerId] ?? '';
        const model = models[connection.providerId] ?? '';
        const inference = inferences[connection.providerId];
        const discovery = discoveredModels[connection.providerId];
        const stream = streaming[connection.providerId];
        const selectedForTask = taskModelSelection?.providerId === connection.providerId;
        return (
          <article className="provider-connection-card" key={connection.providerId}>
            <div className="provider-connection-card-heading">
              <div><strong>{connection.displayName}</strong><span>{connection.defaultModel} · {connection.driverId.replace('desktop-direct.', '')}</span></div>
              <span className="provider-connection-status active">已连接</span>
            </div>
            <div className="provider-connection-details">
              <span className="provider-credential-status available">桌面原生会话已就绪</span>
              <span>密钥不会回显</span>
              {probeLabel(probe) && <span className={`provider-probe-result ${probe?.outcome}`}>{probeLabel(probe)}</span>}
            </div>
            <div className="provider-connection-actions">
              <button type="button" disabled={pending} title="用当前协议、地址、API key 向第三方服务查询模型目录。" onClick={() => onProbe(connection.providerId)}>{pending ? '测试中…' : '测试连接'}</button>
              <button type="button" disabled={pending} title="用当前协议、地址和 API key 查询公开模型目录；第三方未提供目录时仍可手填模型。" onClick={() => onDiscoverModels(connection.providerId)}>{pending ? '查询中…' : '查询模型'}</button>
              <button type="button" className={selectedForTask ? 'selected-task-model' : ''} disabled={pending} title="将该连接明确用于后续任务；不会自动切换到其他 Provider。" onClick={() => onSelectTaskModel({ providerId: connection.providerId, model: model.trim() || undefined })}>{selectedForTask ? '当前任务模型' : '用作任务模型'}</button>
            </div>
            <div className="provider-inference-box">
              <label htmlFor={`provider-prompt-${connection.providerId}`}>向 {connection.displayName} 发送消息</label>
              <textarea id={`provider-prompt-${connection.providerId}`} value={draft} maxLength={24000} onChange={(event) => setDrafts((current) => ({ ...current, [connection.providerId]: event.target.value }))} placeholder={`使用默认模型 ${connection.defaultModel}。`} />
              <input className="provider-model-input" aria-label={`${connection.displayName} 模型标识`} value={model} maxLength={128} onChange={(event) => setModels((current) => ({ ...current, [connection.providerId]: event.target.value }))} placeholder={`可选：改用模型 ${connection.defaultModel}`} />
              {discovery?.outcome === 'reachable' && discovery.models.length === 0 && <p className="provider-model-discovery-note">该服务未提供标准模型列表；请按供应商文档填写模型标识。</p>}
              {discovery && discovery.models.length > 0 && <div className="provider-model-discovery-options" aria-label={`${connection.displayName} 查询到的模型`}>{discovery.models.map((item) => <button key={item} type="button" title={`使用 ${item} 作为此次对话模型。`} onClick={() => setModels((current) => ({ ...current, [connection.providerId]: item }))}>{item}</button>)}</div>}
              {selectedForTask && <p className="provider-model-discovery-note">后续任务将使用：{taskModelSelection?.model ?? (model || connection.defaultModel)}。</p>}
              <div className="provider-inference-footer"><span>请求直接发给您配置的第三方服务；上游 SSE 文本会按分块即时显示。</span><button type="button" title="使用所选协议的标准 HTTPS/SSE 直接请求当前 Provider。" disabled={!draft.trim() || pending} onClick={() => onStream(connection.providerId, draft, model.trim() || undefined)}>{pending ? '流式响应中…' : '流式发送'}</button></div>
              {stream && <div className="provider-inference-result provider-inference-result--stream"><div><strong>{stream.model ?? (model || connection.defaultModel)}</strong><span>{stream.complete ? `${stream.outputCharacters ?? stream.output.length} 字符 · 流式完成` : '正在接收第三方文本分块…'}</span></div><pre>{stream.output || '正在等待模型返回首个文本分块…'}</pre></div>}
              {inference && <div className="provider-inference-result"><div><strong>{inference.model}</strong><span>{inference.outputCharacters} 字符 · {inference.latencyMs} ms</span></div><pre>{inference.output || '模型未返回文本内容。'}</pre></div>}
            </div>
          </article>
        );
      })}
      <p className="provider-connection-note">预置与自定义 Provider 的协议、Base URL、密钥、模型查询和流式发送使用相同实现。模型目录不可用时可继续手动填写模型标识；一次发送只调用当前选择的 Provider，不自动改用其他模型。</p>
    </section>
  );
}
