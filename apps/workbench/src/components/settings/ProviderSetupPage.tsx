import { useMemo, useState } from 'react';
import { ProviderConnectionCenter } from '../observability/ProviderConnectionCenter';
import type { WorkbenchProviderConnection, WorkbenchProviderConnectionProbe, WorkbenchProviderInference } from '../../runtime/task-client';
import './ProviderSetupPage.css';

const QUICK_PATHS = [
  { id: 'openai', protocol: 'OpenAI 格式', title: 'OpenAI 或兼容服务', description: '适合 OpenAI、DeepSeek、Mistral、OpenRouter 等常用兼容协议。' },
  { id: 'anthropic', protocol: 'Anthropic 格式', title: 'Claude / Anthropic', description: '适合 Claude Messages API 兼容的服务。' },
  { id: 'google-gemini', protocol: 'OpenAI 格式', title: 'Google Gemini', description: '使用 Gemini 的 OpenAI 兼容接口。' },
  { id: 'openrouter', protocol: 'OpenAI 格式', title: 'OpenRouter', description: '一个连接访问多个已支持的商业模型。' },
] as const;

export interface ProviderSetupPageProps {
  gatewayAttached: boolean;
  attachingGateway: boolean;
  gatewayError?: string;
  connections?: readonly WorkbenchProviderConnection[];
  probes: Readonly<Record<string, WorkbenchProviderConnectionProbe | undefined>>;
  inferences: Readonly<Record<string, WorkbenchProviderInference | undefined>>;
  error?: string;
  pendingProviderId?: string;
  onAttach(): void;
  onDetach(): void;
  onConfigure(providerId: string, input: { displayName?: string; model?: string; apiKey: string }): void;
  onRefresh(): void;
  onRegister(providerId: string): void;
  onActivate(providerId: string): void;
  onProbe(providerId: string): void;
  onInfer(providerId: string, prompt: string, model?: string): void;
}

export function ProviderSetupPage({ gatewayAttached, attachingGateway, gatewayError, connections, probes, inferences, error, pendingProviderId, onAttach, onDetach, onConfigure, onRefresh, onRegister, onActivate, onProbe, onInfer }: ProviderSetupPageProps) {
  const [providerId, setProviderId] = useState<string>('openai');
  const [displayName, setDisplayName] = useState('我的 OpenAI');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const selected = useMemo(() => connections?.find((item) => item.providerId === providerId), [connections, providerId]);
  const isSubmitting = pendingProviderId === providerId;

  const choose = (nextProviderId: string) => {
    const next = connections?.find((item) => item.providerId === nextProviderId);
    setProviderId(nextProviderId);
    setDisplayName(next?.displayName ?? QUICK_PATHS.find((item) => item.id === nextProviderId)?.title ?? '我的模型连接');
    setModel(next?.defaultModel ?? '');
    setApiKey('');
  };

  const submit = () => {
    if (!apiKey.trim() || !gatewayAttached) return;
    onConfigure(providerId, { ...(displayName.trim() ? { displayName: displayName.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}), apiKey });
    setApiKey('');
  };

  return (
    <div className="provider-setup-page">
      <header className="settings-page-header">
        <div><span>MODEL CONNECTIONS</span><h1>连接第三方模型</h1><p>选择常用协议，填写显示名称、实际模型 ID 和 API key 即可。密钥只保留在当前本机 Gateway 会话内存中。</p></div>
        <div className={`settings-gateway-status${gatewayAttached ? ' attached' : ''}`}><strong>{gatewayAttached ? '本机 Gateway 已附着' : '先附着本机 Gateway'}</strong><span>{gatewayAttached ? '可以开始配置和测试模型。' : '应用不会自动启动服务或读取密钥。'}</span><button type="button" onClick={gatewayAttached ? onDetach : onAttach} disabled={attachingGateway}>{attachingGateway ? '正在检查…' : gatewayAttached ? '断开' : '检查并附着'}</button></div>
      </header>
      {gatewayError && <div className="provider-onboarding-error" role="alert"><strong>尚未连接到本机 Gateway。</strong><span>{gatewayError.includes('Failed to fetch') ? '请先启动本机 Gateway，再重试。详细网络错误已隐藏，避免干扰配置流程。' : gatewayError}</span></div>}
      <section className="provider-onboarding" aria-label="Third-party API setup">
        <div className="onboarding-step"><span>1</span><div><strong>选择协议或供应商</strong><p>预设会自动采用已审核的官方连接方式，不需要填写复杂参数。</p></div></div>
        <div className="provider-preset-grid">
          {QUICK_PATHS.map((path) => <button key={path.id} type="button" className={`provider-preset${providerId === path.id ? ' active' : ''}`} onClick={() => choose(path.id)}><span>{path.protocol}</span><strong>{path.title}</strong><small>{path.description}</small></button>)}
        </div>
        <div className="onboarding-step"><span>2</span><div><strong>填写最少信息</strong><p>模型 ID 必须是你的账户实际可用的名称；API key 不会显示、回传或写入配置文件。</p></div></div>
        <div className="provider-onboarding-form">
          <label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：我的 DeepSeek" /></label>
          <label><span>实际模型 ID</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder={selected?.defaultModel ?? '例如：gpt-4.1-mini'} /></label>
          <label className="provider-key-field"><span>API key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="仅保存到当前 Gateway 会话内存" /><small>关闭 Gateway 后此会话 key 自动失效；可在高级方式中使用环境变量。</small></label>
          <button className="provider-onboarding-submit" type="button" disabled={!gatewayAttached || !apiKey.trim() || isSubmitting} onClick={submit}>{isSubmitting ? '正在保存会话配置…' : '保存并启用连接'}</button>
        </div>
        <div className="provider-onboarding-note"><strong>需要其他供应商？</strong><span>当前内置 OpenAI、Claude、Gemini、DeepSeek、Mistral 与 OpenRouter。OpenAI/Anthropic 两种常用协议位于上方；服务地址不对外开放编辑，避免把本机 Gateway 变成任意网络代理。</span></div>
      </section>
      <section className="provider-advanced-section"><div><span>ADVANCED CONNECTION STATUS</span><h2>已配置连接与测试</h2><p>这里显示状态、单次模型目录测试与受限文本试用。它们均需你点击触发。</p></div><ProviderConnectionCenter connections={connections} probes={probes} inferences={inferences} error={error} pendingProviderId={pendingProviderId} onRefresh={onRefresh} onRegister={onRegister} onActivate={onActivate} onProbe={onProbe} onInfer={onInfer} /></section>
    </div>
  );
}
