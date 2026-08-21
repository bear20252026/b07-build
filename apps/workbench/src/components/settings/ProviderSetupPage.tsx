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
  { id: 'deepseek', protocol: 'openai-compatible', title: 'DeepSeek', description: '官方 OpenAI-compatible Chat Completions API。', defaultModel: 'deepseek-v4-pro' },
  { id: 'mimo', protocol: 'openai-compatible', title: 'Xiaomi MiMo', description: '兼容 OpenAI 与 Anthropic；默认 OpenAI 路线。', defaultModel: 'mimo-v2.5-pro' },
  { id: 'longcat', protocol: 'openai-compatible', title: 'LongCat（美团龙猫）', description: '兼容 OpenAI 与 Anthropic；默认 OpenAI 路线。', defaultModel: 'LongCat-2.0' },
  { id: 'kimi', protocol: 'openai-compatible', title: 'Moonshot Kimi', description: '官方 OpenAI-compatible API。', defaultModel: 'kimi-k3' },
  { id: 'zhipu', protocol: 'openai-compatible', title: '智谱 GLM', description: '官方 OpenAI-compatible API。', defaultModel: 'glm-5.3' },
  { id: 'openai', protocol: 'openai-compatible', title: 'OpenAI', description: '官方 Chat Completions API。', defaultModel: 'gpt-5.6' },
  { id: 'google-gemini', protocol: 'openai-compatible', title: 'Google Gemini', description: '使用 Gemini 的 OpenAI-compatible API。', defaultModel: 'gemini-3.7-flash' },
  { id: 'mistral', protocol: 'openai-compatible', title: 'Mistral AI', description: '使用 OpenAI-compatible API。', defaultModel: 'mistral-large-latest' },
  { id: 'openrouter', protocol: 'openai-compatible', title: 'OpenRouter', description: '通过一个已审核连接使用多个模型。', defaultModel: 'openrouter/auto' },
  { id: 'anthropic', protocol: 'anthropic-compatible', title: 'Anthropic Claude', description: '官方 Claude Messages API。', defaultModel: 'claude-opus-5' },
];

const PROTOCOLS: readonly { id: Protocol; label: string; caption: string }[] = [
  { id: 'openai-compatible', label: 'OpenAI-compatible', caption: '适用于 DeepSeek、MiMo、LongCat、Kimi、智谱与主流兼容模型。' },
  { id: 'anthropic-compatible', label: 'Anthropic-compatible', caption: '适用于 Claude 与标准 Anthropic Messages API。' },
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
  onConfigureCustom(input: { displayName: string; protocol: Protocol; baseUrl: string; model: string; apiKey: string }): void;
  onManageConnections(): void;
}

/**
 * 预设连接只提交显示名、模型和 key；custom 连接额外提交一次经 Gateway 审核的 HTTPS base URL。
 * 密钥和 endpoint 均不写入浏览器持久化状态、SQLite、Profile 或任务事件。
 */
export function ProviderSetupPage({ gatewayAttached, attachingGateway, gatewayError, connections, error, pendingProviderId, onAttach, onDetach, onConfigure, onConfigureCustom, onManageConnections }: ProviderSetupPageProps) {
  const [protocol, setProtocol] = useState<Protocol>('openai-compatible');
  const firstPreset = PRESETS.find((item) => item.protocol === 'openai-compatible')!;
  const [providerId, setProviderId] = useState(firstPreset.id);
  const [customMode, setCustomMode] = useState(false);
  const [displayName, setDisplayName] = useState(`我的 ${firstPreset.title}`);
  const [model, setModel] = useState(firstPreset.defaultModel);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const selected = useMemo(() => PRESETS.find((item) => item.id === providerId) ?? firstPreset, [providerId]);
  const isSubmitting = pendingProviderId === (customMode ? 'custom' : providerId);
  const selectedConnection = connections?.find((item) => item.providerId === providerId);
  const protocolPresets = PRESETS.filter((item) => item.protocol === protocol);
  const actionableError = error ?? gatewayError;

  const selectProtocol = (nextProtocol: Protocol) => {
    setProtocol(nextProtocol);
    if (!customMode) {
      const next = PRESETS.find((item) => item.protocol === nextProtocol)!;
      setProviderId(next.id);
      setDisplayName(`我的 ${next.title}`);
      setModel(next.defaultModel);
    }
    setApiKey('');
  };

  const choosePreset = (nextProviderId: string) => {
    const next = PRESETS.find((item) => item.id === nextProviderId)!;
    const connection = connections?.find((item) => item.providerId === nextProviderId);
    setCustomMode(false);
    setProviderId(next.id);
    setDisplayName(connection?.displayName ?? `我的 ${next.title}`);
    setModel(connection?.defaultModel ?? next.defaultModel);
    setBaseUrl('');
    setApiKey('');
  };

  const chooseCustom = () => {
    setCustomMode(true);
    setDisplayName('我的兼容模型');
    setModel('my-compatible-model');
    setBaseUrl('');
    setApiKey('');
  };

  const submit = () => {
    if (!apiKey.trim() || !gatewayAttached) return;
    if (customMode) {
      if (!baseUrl.trim()) return;
      onConfigureCustom({ displayName: displayName.trim(), protocol, baseUrl: baseUrl.trim(), model: model.trim(), apiKey });
    } else {
      onConfigure(providerId, { displayName: displayName.trim(), model: model.trim(), apiKey });
    }
    setApiKey('');
  };

  return (
    <div className="provider-setup-page provider-setup-page--focused">
      <header className="settings-page-header provider-setup-header">
        <div><span>THIRD-PARTY MODEL SETUP</span><h1>连接第三方模型</h1><p>选择已审核服务，或登记符合 OpenAI / Anthropic 格式的自有模型。复杂测试和管理在下一页按需打开。</p></div>
        <div className={`settings-gateway-status${gatewayAttached ? ' attached' : ''}`}><strong>{gatewayAttached ? '本机 Gateway 已就绪' : '第 0 步：启动本机 Gateway'}</strong><span>{gatewayAttached ? '现在可把 API key 安全交给当前 Gateway 会话。' : '仅在你点击后启动内置回环服务；应用打开时不会自动运行后台进程。'}</span><button type="button" onClick={gatewayAttached ? onDetach : onAttach} disabled={attachingGateway}>{attachingGateway ? '正在启动并附着…' : gatewayAttached ? '断开 Gateway' : '启动并附着 Gateway'}</button></div>
      </header>
      {actionableError && <div className="provider-onboarding-error" role="alert"><strong>连接尚未完成。</strong><span>{actionableError}</span></div>}
      <section className="provider-onboarding provider-onboarding--compact" aria-label="Third-party API setup">
        <div className="onboarding-step"><span>1</span><div><strong>选择兼容协议</strong><p>已审核预设会使用固定官方服务地址；自定义连接将以此协议审核你的 HTTPS Base URL。</p></div></div>
        <div className="provider-protocol-grid" role="radiogroup" aria-label="选择 API 协议">
          {PROTOCOLS.map((item) => <button aria-checked={protocol === item.id} className={`provider-protocol${protocol === item.id ? ' active' : ''}`} key={item.id} onClick={() => selectProtocol(item.id)} role="radio" type="button"><strong>{item.label}</strong><small>{item.caption}</small></button>)}
        </div>
        <div className="onboarding-step"><span>2</span><div><strong>选择服务</strong><p>{customMode ? '你正在登记自己的兼容 API。' : protocol === 'openai-compatible' ? '选择你的 API key 所属服务。' : '选择 Claude 服务后继续填写你的 key。'}</p></div></div>
        <div className="provider-preset-grid provider-preset-grid--compact">
          {protocolPresets.map((item) => <button key={item.id} type="button" className={`provider-preset${!customMode && providerId === item.id ? ' active' : ''}`} onClick={() => choosePreset(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}
          <button type="button" className={`provider-preset provider-preset--custom${customMode ? ' active' : ''}`} onClick={chooseCustom}><strong>自定义兼容 API</strong><small>连接自己的 OpenAI 或 Anthropic-compatible 模型。</small></button>
        </div>
        <div className="onboarding-step"><span>3</span><div><strong>{customMode ? '填写四项连接信息' : '填写三项信息'}</strong><p>{customMode ? 'Base URL 只在当前 Gateway 会话中保存，会拒绝 HTTP、本机、私网和完整操作路径。' : '模型名称已预填为示例；请按你的账户可用模型修改。API key 不会显示、回传或写入配置文件。'}</p></div></div>
        <div className="provider-onboarding-form">
          <label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder={customMode ? '例如：我的公司模型' : '例如：我的 DeepSeek'} /></label>
          {customMode && <label><span>HTTPS Base URL</span><input value={baseUrl} inputMode="url" maxLength={512} onChange={(event) => setBaseUrl(event.target.value)} placeholder={protocol === 'openai-compatible' ? 'https://api.example.com/v1' : 'https://api.example.com'} /><small>只接受公开 HTTPS 域名和 Base URL；无需也不能填写 `/chat/completions`、`/messages`、header 或代理规则。</small></label>}
          <label><span>实际模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder={selected.defaultModel} /></label>
          <label className="provider-key-field"><span>API key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴第三方服务的 API key" /><small>该 key 只存在于当前 Gateway 进程内存；关闭 Gateway 后自动失效。</small></label>
          <button className="provider-onboarding-submit" type="button" disabled={!gatewayAttached || !apiKey.trim() || !displayName.trim() || !model.trim() || (customMode && !baseUrl.trim()) || isSubmitting} onClick={submit}>{isSubmitting ? '正在保存并启用…' : customMode ? '保存自定义连接' : '保存并启用连接'}</button>
        </div>
      </section>
      <section className="provider-next-step" aria-live="polite"><div><span>AFTER SETUP</span><strong>{customMode ? '保存后可进行一次显式测试' : selectedConnection?.profileStatus === 'active' ? `${selectedConnection.displayName} 已启用` : '保存后可进行一次显式测试'}</strong><p>连接状态、模型目录探测和受限文本试用均不会自动发生。准备好后，在“已连接模型”页面手动测试。</p></div><button type="button" onClick={onManageConnections}>查看已连接模型 →</button></section>
      <p className="provider-compatibility-note">自定义远程模型会按你的提示向你填写的服务发送请求。为避免 Gateway 成为任意网络代理，自定义连接仅在显式保存后以会话状态存在，且拒绝 HTTP、本机、私网、IP 地址、完整操作路径和任意 header；自托管本地模型请使用本地模型端点管理。</p>
    </div>
  );
}
