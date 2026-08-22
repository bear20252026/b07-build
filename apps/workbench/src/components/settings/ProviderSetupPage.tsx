import { useMemo, useState } from 'react';
import type { WorkbenchProviderConnection } from '../../runtime/task-client';
import './ProviderSetupPage.css';

type Protocol = 'openai-compatible' | 'anthropic-compatible';

type ProviderPreset = {
  id: string;
  title: string;
  description: string;
  defaultModel: string;
  defaultBaseUrl: string;
};

const PRESETS: readonly ProviderPreset[] = [
  { id: 'deepseek', title: 'DeepSeek', description: 'OpenAI-compatible', defaultModel: 'deepseek-v4-pro', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  { id: 'mimo', title: 'Xiaomi MiMo（按量）', description: 'sk- 密钥', defaultModel: 'mimo-v2.5-pro', defaultBaseUrl: 'https://api.xiaomimimo.com/v1' },
  { id: 'mimo-token-plan-cn', title: 'MiMo Token Plan（中国）', description: 'tp- 订阅密钥', defaultModel: 'mimo-v2.5-pro', defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
  { id: 'longcat', title: 'LongCat', description: '美团龙猫', defaultModel: 'LongCat-2.0', defaultBaseUrl: 'https://api.longcat.chat/openai/v1' },
  { id: 'kimi', title: 'Kimi', description: 'Moonshot AI', defaultModel: 'kimi-k3', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', title: '智谱 GLM', description: 'GLM 系列', defaultModel: 'glm-5.3', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'openai', title: 'OpenAI', description: 'Chat Completions', defaultModel: 'gpt-5.6', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'google-gemini', title: 'Google Gemini', description: 'OpenAI-compatible', defaultModel: 'gemini-3.7-flash', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'mistral', title: 'Mistral AI', description: 'OpenAI-compatible', defaultModel: 'mistral-large-latest', defaultBaseUrl: 'https://api.mistral.ai/v1' },
  { id: 'openrouter', title: 'OpenRouter', description: '多模型路由', defaultModel: 'openrouter/auto', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'anthropic', title: 'Anthropic Claude', description: 'Messages API', defaultModel: 'claude-opus-5', defaultBaseUrl: 'https://api.anthropic.com' },
];

export interface ProviderSetupPageProps {
  gatewayAttached: boolean;
  attachingGateway: boolean;
  gatewayError?: string;
  connections?: readonly WorkbenchProviderConnection[];
  error?: string;
  pendingProviderId?: string;
  onAttach(): void;
  onConfigure(providerId: string, input: { displayName?: string; model?: string; baseUrl?: string; apiKey: string }): void;
  onConfigureCustom(input: { displayName: string; protocol: Protocol; baseUrl: string; model: string; apiKey: string }): void;
  onManageConnections(): void;
}

/**
 * 独立模型配置窗口的表单内容。预置只提供可编辑默认值：地址、模型、显示名和密钥均由
 * 用户在明确的连接动作中提交，且仅作为当前 Gateway 会话的内存配置，不写入任务或浏览器状态。
 */
export function ProviderSetupPage({ gatewayAttached, attachingGateway, gatewayError, error, pendingProviderId, onAttach, onConfigure, onConfigureCustom, onManageConnections }: ProviderSetupPageProps) {
  const firstPreset = PRESETS[0];
  const [providerId, setProviderId] = useState(firstPreset.id);
  const [customMode, setCustomMode] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('openai-compatible');
  const [displayName, setDisplayName] = useState(`我的 ${firstPreset.title}`);
  const [model, setModel] = useState(firstPreset.defaultModel);
  const [baseUrl, setBaseUrl] = useState(firstPreset.defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const selected = useMemo(() => PRESETS.find((item) => item.id === providerId) ?? firstPreset, [providerId]);
  const isSubmitting = pendingProviderId === (customMode ? 'custom' : providerId);

  const chooseService = (nextValue: string) => {
    if (nextValue === 'custom') {
      setCustomMode(true);
      setDisplayName('我的兼容模型');
      setModel('my-compatible-model');
      setBaseUrl('');
      setApiKey('');
      return;
    }
    const next = PRESETS.find((item) => item.id === nextValue) ?? firstPreset;
    setCustomMode(false);
    setProviderId(next.id);
    setDisplayName(`我的 ${next.title}`);
    setModel(next.defaultModel);
    setBaseUrl(next.defaultBaseUrl);
    setApiKey('');
  };

  const submit = () => {
    if (!apiKey.trim() || !baseUrl.trim() || !model.trim()) return;
    if (customMode) {
      if (!displayName.trim()) return;
      onConfigureCustom({ displayName: displayName.trim(), protocol, baseUrl: baseUrl.trim(), model: model.trim(), apiKey });
    } else {
      onConfigure(providerId, { displayName: displayName.trim(), model: model.trim(), baseUrl: baseUrl.trim(), apiKey });
    }
    setApiKey('');
  };

  return (
    <div className="provider-setup-page provider-setup-page--window" aria-label="添加或编辑第三方模型">
      <div className="provider-window-intro">
        <div><span>MODEL CONNECTION</span><h2>添加模型</h2><p>预设地址只是起点。请按供应商控制台填写或更正基础地址，再连接并测试。</p></div>
        <div className={`provider-window-gateway${gatewayAttached ? ' ready' : ''}`}><strong>{gatewayAttached ? 'Gateway 已就绪' : attachingGateway ? '正在准备 Gateway' : '连接时自动准备'}</strong><small>地址和密钥只在当前本机会话内存中有效。</small></div>
      </div>
      {gatewayError && <div className="provider-window-error" role="alert"><strong>Gateway 尚未准备好。</strong><span>{gatewayError}</span><button type="button" onClick={onAttach} disabled={attachingGateway}>{attachingGateway ? '正在准备…' : '重新准备'}</button></div>}
      {error && <div className="provider-window-error" role="alert"><strong>模型连接未完成。</strong><span>{error}</span></div>}
      <div className="provider-window-form">
        <label className="provider-window-wide"><span>提供商</span><select aria-label="选择模型提供商" value={customMode ? 'custom' : providerId} onChange={(event) => chooseService(event.target.value)}>{PRESETS.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.description}</option>)}<option value="custom">自定义 / Custom · OpenAI 或 Anthropic-compatible</option></select></label>
        {customMode && <div className="provider-protocol-inline provider-window-wide" role="radiogroup" aria-label="选择自定义 API 协议"><button className={protocol === 'openai-compatible' ? 'active' : ''} title="使用 OpenAI Chat Completions 兼容格式。" type="button" role="radio" aria-checked={protocol === 'openai-compatible'} onClick={() => setProtocol('openai-compatible')}>OpenAI-compatible</button><button className={protocol === 'anthropic-compatible' ? 'active' : ''} title="使用 Anthropic Messages 兼容格式。" type="button" role="radio" aria-checked={protocol === 'anthropic-compatible'} onClick={() => setProtocol('anthropic-compatible')}>Anthropic-compatible</button></div>}
        <label className="provider-window-wide"><span>连接地址 / Base URL</span><input value={baseUrl} inputMode="url" maxLength={512} onChange={(event) => setBaseUrl(event.target.value)} placeholder={customMode ? 'https://api.example.com/v1' : selected.defaultBaseUrl} /><small>填写供应商控制台给出的基础地址；不要输入完整 chat completion 或 messages 路径。</small></label>
        <label><span>模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder={customMode ? 'my-compatible-model' : selected.defaultModel} /></label>
        <label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder={customMode ? '我的兼容模型' : `我的 ${selected.title}`} /></label>
        <label className="provider-key-field provider-window-wide"><span>API key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴 API key" /><small>密钥不会显示在已连接列表、任务事件或日志中；关闭 Gateway 后自动失效。</small></label>
      </div>
      {!customMode && providerId.startsWith('mimo') && <p className="provider-compatibility-note">`sk-` 使用“MiMo（按量）”；`tp-` 使用“MiMo Token Plan（中国）”。Token Plan 的默认 OpenAI Base URL 已按官方中国区地址预填，仍可由你更正。</p>}
      <div className="provider-window-actions"><button className="provider-onboarding-submit" title="将当前字段作为一次会话连接配置，并立即测试模型列表。" type="button" disabled={!apiKey.trim() || !baseUrl.trim() || !model.trim() || (customMode && !displayName.trim()) || isSubmitting || attachingGateway} onClick={submit}>{isSubmitting ? '正在连接并测试…' : attachingGateway ? '正在准备 Gateway…' : '连接并测试'}</button><button type="button" title="查看已连接模型与最近测试结果。" className="provider-next-link" onClick={onManageConnections}>已连接模型 →</button></div>
      <p className="provider-window-footnote">仅接受公开 HTTPS 服务地址。若使用本地模型，请在“本地模型端点管理”中配置，而不要在此窗口填写回环或内网地址。</p>
    </div>
  );
}
