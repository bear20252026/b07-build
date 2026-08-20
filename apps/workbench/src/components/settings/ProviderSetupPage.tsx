import { useMemo, useState } from 'react';
import type { WorkbenchProviderConnection } from '../../runtime/task-client';
import './ProviderSetupPage.css';

type Protocol = 'openai-compatible' | 'anthropic-compatible';

type ProviderPreset = {
  id: string;
  protocol: Protocol;
  title: string;
  description: string;
  defaultModel: string;
};

const PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', protocol: 'openai-compatible', title: 'OpenAI', description: '官方 Chat Completions API。', defaultModel: 'gpt-5.6' },
  { id: 'deepseek', protocol: 'openai-compatible', title: 'DeepSeek', description: '使用 OpenAI-compatible API。', defaultModel: 'deepseek-v4-pro' },
  { id: 'google-gemini', protocol: 'openai-compatible', title: 'Google Gemini', description: '使用 Gemini 的 OpenAI-compatible API。', defaultModel: 'gemini-3.7-flash' },
  { id: 'mistral', protocol: 'openai-compatible', title: 'Mistral AI', description: '使用 OpenAI-compatible API。', defaultModel: 'mistral-large-latest' },
  { id: 'openrouter', protocol: 'openai-compatible', title: 'OpenRouter', description: '通过一个已审核连接使用多个模型。', defaultModel: 'openrouter/auto' },
  { id: 'anthropic', protocol: 'anthropic-compatible', title: 'Anthropic Claude', description: '官方 Claude Messages API。', defaultModel: 'claude-opus-5' },
];

const PROTOCOLS: readonly { id: Protocol; label: string; caption: string }[] = [
  { id: 'openai-compatible', label: 'OpenAI-compatible', caption: '适用于 OpenAI、DeepSeek、Gemini、Mistral 与 OpenRouter。' },
  { id: 'anthropic-compatible', label: 'Anthropic-compatible', caption: '适用于 Claude Messages API。' },
];

export interface ProviderSetupPageProps {
  gatewayAttached: boolean;
  attachingGateway: boolean;
  gatewayError?: string;
  connections?: readonly WorkbenchProviderConnection[];
  error?: string;
  pendingProviderId?: string;
  onAttach(): void;
  onDetach(): void;
  onConfigure(providerId: string, input: { displayName?: string; model?: string; apiKey: string }): void;
  onManageConnections(): void;
}

/**
 * P12 新手连接页只包含路径选择和最少字段。密钥由 Gateway 收到后只存在于会话内存；
 * 状态、探测与受限文本调用在“已连接模型”二级页按需展示。
 */
export function ProviderSetupPage({ gatewayAttached, attachingGateway, gatewayError, connections, error, pendingProviderId, onAttach, onDetach, onConfigure, onManageConnections }: ProviderSetupPageProps) {
  const [protocol, setProtocol] = useState<Protocol>('openai-compatible');
  const firstPreset = PRESETS.find((item) => item.protocol === 'openai-compatible')!;
  const [providerId, setProviderId] = useState(firstPreset.id);
  const [displayName, setDisplayName] = useState(`我的 ${firstPreset.title}`);
  const [model, setModel] = useState(firstPreset.defaultModel);
  const [apiKey, setApiKey] = useState('');
  const selected = useMemo(() => PRESETS.find((item) => item.id === providerId) ?? firstPreset, [providerId]);
  const isSubmitting = pendingProviderId === providerId;
  const selectedConnection = connections?.find((item) => item.providerId === providerId);
  const protocolPresets = PRESETS.filter((item) => item.protocol === protocol);
  const actionableError = error ?? gatewayError;

  const selectProtocol = (nextProtocol: Protocol) => {
    const next = PRESETS.find((item) => item.protocol === nextProtocol)!;
    setProtocol(nextProtocol);
    setProviderId(next.id);
    setDisplayName(`我的 ${next.title}`);
    setModel(next.defaultModel);
    setApiKey('');
  };

  const choosePreset = (nextProviderId: string) => {
    const next = PRESETS.find((item) => item.id === nextProviderId)!;
    const connection = connections?.find((item) => item.providerId === nextProviderId);
    setProviderId(next.id);
    setDisplayName(connection?.displayName ?? `我的 ${next.title}`);
    setModel(connection?.defaultModel ?? next.defaultModel);
    setApiKey('');
  };

  const submit = () => {
    if (!apiKey.trim() || !gatewayAttached) return;
    onConfigure(providerId, { displayName: displayName.trim(), model: model.trim(), apiKey });
    setApiKey('');
  };

  return (
    <div className="provider-setup-page provider-setup-page--focused">
      <header className="settings-page-header provider-setup-header">
        <div><span>THIRD-PARTY MODEL SETUP</span><h1>连接第三方模型</h1><p>只需选择常用兼容协议，填写显示名称、实际模型名称和 API key。复杂的测试和管理在下一页按需打开。</p></div>
        <div className={`settings-gateway-status${gatewayAttached ? ' attached' : ''}`}><strong>{gatewayAttached ? '本机 Gateway 已就绪' : '第 0 步：启动本机 Gateway'}</strong><span>{gatewayAttached ? '现在可把 API key 安全交给当前 Gateway 会话。' : '仅在你点击后启动内置回环服务；应用打开时不会自动运行后台进程。'}</span><button type="button" onClick={gatewayAttached ? onDetach : onAttach} disabled={attachingGateway}>{attachingGateway ? '正在启动并附着…' : gatewayAttached ? '断开 Gateway' : '启动并附着 Gateway'}</button></div>
      </header>
      {actionableError && <div className="provider-onboarding-error" role="alert"><strong>连接尚未完成。</strong><span>{actionableError}</span></div>}
      <section className="provider-onboarding provider-onboarding--compact" aria-label="Third-party API setup">
        <div className="onboarding-step"><span>1</span><div><strong>选择兼容协议</strong><p>服务地址已由内置目录审核；不需要也不能填写复杂 endpoint。</p></div></div>
        <div className="provider-protocol-grid" role="radiogroup" aria-label="选择 API 协议">
          {PROTOCOLS.map((item) => <button aria-checked={protocol === item.id} className={`provider-protocol${protocol === item.id ? ' active' : ''}`} key={item.id} onClick={() => selectProtocol(item.id)} role="radio" type="button"><strong>{item.label}</strong><small>{item.caption}</small></button>)}
        </div>
        <div className="onboarding-step"><span>2</span><div><strong>选择服务</strong><p>{protocol === 'openai-compatible' ? '选择你的 API key 所属服务。' : '选择 Claude 服务后继续填写你的 key。'}</p></div></div>
        <div className="provider-preset-grid provider-preset-grid--compact">
          {protocolPresets.map((item) => <button key={item.id} type="button" className={`provider-preset${providerId === item.id ? ' active' : ''}`} onClick={() => choosePreset(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}
        </div>
        <div className="onboarding-step"><span>3</span><div><strong>填写三项信息</strong><p>模型名称已预填为示例；请按你的账户可用模型修改。API key 不会显示、回传或写入配置文件。</p></div></div>
        <div className="provider-onboarding-form">
          <label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：我的 DeepSeek" /></label>
          <label><span>实际模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder={selected.defaultModel} /></label>
          <label className="provider-key-field"><span>API key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴第三方服务的 API key" /><small>该 key 只存在于当前 Gateway 进程内存；关闭 Gateway 后自动失效。</small></label>
          <button className="provider-onboarding-submit" type="button" disabled={!gatewayAttached || !apiKey.trim() || !displayName.trim() || !model.trim() || isSubmitting} onClick={submit}>{isSubmitting ? '正在保存并启用…' : '保存并启用连接'}</button>
        </div>
      </section>
      <section className="provider-next-step" aria-live="polite"><div><span>AFTER SETUP</span><strong>{selectedConnection?.profileStatus === 'active' ? `${selectedConnection.displayName} 已启用` : '保存后可进行一次显式测试'}</strong><p>连接状态、模型目录探测和受限文本试用均不会自动发生。准备好后，在“已连接模型”页面手动测试。</p></div><button type="button" onClick={onManageConnections}>查看已连接模型 →</button></section>
      <p className="provider-compatibility-note">需要不在上方的服务？请选择对应的兼容协议并通过后续受控目录接入。为了避免把本机 Gateway 变为任意网络代理，本版本不接受浏览器输入任意服务地址。</p>
    </div>
  );
}
