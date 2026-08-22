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
  onRegister(providerId: string): void;
  onActivate(providerId: string): void;
  onProbe(providerId: string): void;
  onDiscoverModels(providerId: string): void;
  onSelectTaskModel(selection: Readonly<{ providerId: string; model?: string }>): void;
  onInfer(providerId: string, prompt: string, model?: string): void;
  onStream(providerId: string, prompt: string, model?: string): void;
}

function statusLabel(status: WorkbenchProviderConnection['profileStatus']): string {
  const labels: Record<WorkbenchProviderConnection['profileStatus'], string> = {
    'not-registered': '未登记', registered: '已登记', active: '已启用', disabled: '已停用', revoked: '已撤销',
  };
  return labels[status];
}

function credentialLabel(status: WorkbenchProviderConnection['credentialAvailability']): string {
  const labels: Record<WorkbenchProviderConnection['credentialAvailability'], string> = {
    available: 'Gateway 凭据已就绪', missing: 'Gateway 未发现凭据', 'unsupported-reference': '凭据引用不受支持',
  };
  return labels[status];
}

function probeLabel(probe: WorkbenchProviderConnectionProbe | undefined): string | undefined {
  if (!probe) return undefined;
  const labels: Record<WorkbenchProviderConnectionProbe['outcome'], string> = {
    reachable: '连接可达', 'missing-credential': '未发现凭据', 'not-registered': '尚未登记', 'not-active': '尚未启用', rejected: '认证、配额或账户策略拒绝', unreachable: '网络不可达或超时',
  };
  return probe.latencyMs === undefined ? labels[probe.outcome] : `${labels[probe.outcome]} · ${probe.latencyMs} ms`;
}

/**
 * 仅面向本地 Gateway 的受控多模型控制面。此组件没有密钥输入框、endpoint 编辑器、
 * 自动探测、自动激活或默认模型切换能力；每一次网络诊断均由操作者点击触发。
 */
export function ProviderConnectionCenter({ connections, probes, inferences, streaming, discoveredModels, taskModelSelection, error, pendingProviderId, onRefresh, onRegister, onActivate, onProbe, onDiscoverModels, onSelectTaskModel, onInfer, onStream }: ProviderConnectionCenterProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [models, setModels] = useState<Readonly<Record<string, string>>>({});
  return (
    <section className="provider-connection-center" aria-label="Commercial model provider connections">
      <div className="provider-connection-heading">
        <div>
          <div className="panel-eyebrow">CONTROLLED MODEL CONNECTIONS</div>
          <h2>商业模型连接</h2>
          <p>仅通过本地 Gateway 显式连接；密钥始终留在 Gateway host，不写入工作台、Profile 账本或任务事件。</p>
        </div>
        <button className="panel-refresh-button" title="重新读取本机 Gateway 的脱敏连接目录；不探测网络、不调用模型。" type="button" onClick={onRefresh}>刷新状态</button>
      </div>
      {error && <p className="provider-connection-error" role="alert">{error}</p>}
      {!connections && <p className="provider-connection-empty">正在读取本地 Gateway 的供应商目录…</p>}
      {connections?.map((connection) => {
        const pending = pendingProviderId === connection.providerId;
        const probe = probes[connection.providerId];
        const canActivate = connection.profileStatus === 'registered' && connection.credentialAvailability === 'available';
        const canProbe = connection.profileStatus === 'active' && connection.credentialAvailability === 'available';
        const draft = drafts[connection.providerId] ?? '';
        const model = models[connection.providerId] ?? '';
        const inference = inferences[connection.providerId];
        const discovery = discoveredModels[connection.providerId];
        const stream = streaming[connection.providerId];
        const selectedForTask = taskModelSelection?.providerId === connection.providerId;
        return (
          <article className="provider-connection-card" key={connection.providerId}>
            <div className="provider-connection-card-heading">
              <div>
                <strong>{connection.displayName}</strong>
                <span>{connection.defaultModel} · {connection.driverId}</span>
              </div>
              <span className={`provider-connection-status ${connection.profileStatus}`}>{statusLabel(connection.profileStatus)}</span>
            </div>
            <div className="provider-connection-details">
              <span className={`provider-credential-status ${connection.credentialAvailability}`}>{credentialLabel(connection.credentialAvailability)}</span>
              <span>引用：{connection.credentialReference}</span>
              {probeLabel(probe) && <span className={`provider-probe-result ${probe?.outcome}`}>{probeLabel(probe)}</span>}
            </div>
            <div className="provider-connection-actions">
              {connection.profileStatus === 'not-registered' && <button type="button" title="创建不含 API key 的本地 Profile metadata；不会联网或调用模型。" disabled={pending} onClick={() => onRegister(connection.providerId)}>{pending ? '处理中…' : '登记连接'}</button>}
              {connection.profileStatus === 'registered' && <button type="button" disabled={!canActivate || pending} title={canActivate ? '显式启用此供应商 Profile；不测试连接' : '请先在 Gateway host 配置凭据引用'} onClick={() => onActivate(connection.providerId)}>{pending ? '处理中…' : '启用 Profile'}</button>}
              {connection.profileStatus === 'active' && <button type="button" disabled={!canProbe || pending} title={canProbe ? '显式发起一次只读模型目录探测' : 'Gateway 当前未发现凭据'} onClick={() => onProbe(connection.providerId)}>{pending ? '诊断中…' : '测试连接'}</button>}
              {connection.profileStatus === 'active' && <button type="button" disabled={!canProbe || pending} title={canProbe ? '按当前会话的协议、地址与凭据查询公开模型目录；不会回传地址或密钥。' : 'Gateway 当前未发现凭据'} onClick={() => onDiscoverModels(connection.providerId)}>{pending ? '查询中…' : '查询模型'}</button>}
              {connection.profileStatus === 'active' && <button type="button" className={selectedForTask ? 'selected-task-model' : ''} disabled={!canProbe || pending} title="将该模型明确绑定到随后从首页发送的任务；不会自动切换其他连接。" onClick={() => onSelectTaskModel({ providerId: connection.providerId, model: model.trim() || undefined })}>{selectedForTask ? '当前任务模型' : '用作任务模型'}</button>}
              {(connection.profileStatus === 'disabled' || connection.profileStatus === 'revoked') && <span className="provider-connection-locked">此 Profile 已被显式限制，不能由 Workbench 重新启用。</span>}
            </div>
            {connection.profileStatus === 'active' && (
              <div className="provider-inference-box">
                <label htmlFor={`provider-prompt-${connection.providerId}`}>向 {connection.displayName} 发送一次受控文本请求</label>
                <textarea id={`provider-prompt-${connection.providerId}`} value={draft} maxLength={24000} onChange={(event) => setDrafts((current) => ({ ...current, [connection.providerId]: event.target.value }))} placeholder={`使用默认模型 ${connection.defaultModel}；不允许工具、端点或密钥输入。`} />
                <input className="provider-model-input" aria-label={`${connection.displayName} 模型标识`} value={model} maxLength={128} onChange={(event) => setModels((current) => ({ ...current, [connection.providerId]: event.target.value }))} placeholder={`可选：覆写默认模型 ${connection.defaultModel}`} />
                {discovery?.outcome === 'reachable' && discovery.models.length === 0 && <p className="provider-model-discovery-note">该服务没有标准模型列表；请按供应商文档填写模型标识。</p>}
                {discovery && discovery.models.length > 0 && <div className="provider-model-discovery-options" aria-label={`${connection.displayName} 查询到的模型`}>{discovery.models.map((item) => <button key={item} type="button" title={`使用 ${item} 作为此次文本请求的模型标识。`} onClick={() => setModels((current) => ({ ...current, [connection.providerId]: item }))}>{item}</button>)}</div>}
                {selectedForTask && <p className="provider-model-discovery-note">本任务模型已明确选择：{taskModelSelection?.model ?? connection.defaultModel}。</p>}
                <div className="provider-inference-footer">
                  <span>发送前请确认文本可离开本机。执行时不会自动调用工具或启动其他连接。</span>
                  <button type="button" title="使用当前 Provider 的标准 SSE 响应流，文本分块抵达时立即呈现在此处；不会调用工具、MCP、Shell、浏览器或其他 Provider。" disabled={!draft.trim() || pending} onClick={() => onStream(connection.providerId, draft, model.trim() || undefined)}>{pending ? '流式响应中…' : '流式发送'}</button>
                </div>
                {stream && <div className="provider-inference-result provider-inference-result--stream"><div><strong>{stream.model ?? (model || connection.defaultModel)}</strong><span>{stream.complete ? `${stream.outputCharacters ?? stream.output.length} 字符 · 流式完成` : '正在接收上游文本分块…'}</span></div><pre>{stream.output || '正在等待模型返回首个文本分块…'}</pre></div>}
                {inference && <div className="provider-inference-result"><div><strong>{inference.model}</strong><span>{inference.outputCharacters} 字符 · {inference.latencyMs} ms · Profile r{inference.profileRevision}</span></div><pre>{inference.output || '模型未返回文本内容。'}</pre></div>}
              </div>
            )}
          </article>
        );
      })}
      <p className="provider-connection-note">登记与启用均不会自动发送模型请求；“测试连接”和“查询模型”只在你点击后对已启用供应商执行一次受限模型目录请求。模型列表不可用时仍可手动填写模型标识；“发送文本请求”仅执行一次受限聊天调用，不自动运行工具、MCP、Shell、浏览器或其他 Provider。</p>
    </section>
  );
}
