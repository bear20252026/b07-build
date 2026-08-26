export interface LocalDataFlowBoardProps {
  localServiceReady: boolean;
  connectedProviderCount: number;
  taskFileCount: number;
  onOpenModels(): void;
}

type FlowBlock = {
  eyebrow: string;
  title: string;
  description: string;
  state: 'ready' | 'waiting' | 'local';
};

/**
 * P15 本地数据流说明块。
 * 它只呈现 App 已拥有的脱敏状态，不能附着 本机能力服务、读取凭据、发起 Provider 请求或读取文件内容。
 */
export function LocalDataFlowBoard({ localServiceReady, connectedProviderCount, taskFileCount, onOpenModels }: LocalDataFlowBoardProps) {
  const localServiceTitle = localServiceReady ? '本机策略边界已就绪' : '等待显式附着';
  const providerTitle = connectedProviderCount > 0 ? `${connectedProviderCount} 个模型连接可用` : '尚未配置会话连接';
  const blocks: readonly FlowBlock[] = [
    {
      eyebrow: 'WORKBENCH',
      title: '本地工作台',
      description: '页面只向固定的 127.0.0.1 回环服务发送受控意图，不直接连接模型服务商。',
      state: 'local',
    },
    {
      eyebrow: 'GATEWAY',
      title: localServiceTitle,
      description: localServiceReady ? '会话凭据、允许列表、审批和预算策略均在本机 本机能力服务 内执行。' : '桌面应用不会自动启动后台服务；请在需要时明确附着本机 本机能力服务。',
      state: localServiceReady ? 'ready' : 'waiting',
    },
    {
      eyebrow: 'PROVIDER',
      title: providerTitle,
      description: connectedProviderCount > 0 ? '模型调用仍需你的明确动作；Provider 只收到该请求所必需的内容。' : '配置连接前不会尝试网络探测、模型调用或读取任何 API key。',
      state: connectedProviderCount > 0 ? 'ready' : 'waiting',
    },
    {
      eyebrow: 'LOCAL RECORD',
      title: `${taskFileCount} 个任务文件`,
      description: '任务事件、专属文件 metadata 与交付收据保留在本机受控工作区；右侧可审查产物。',
      state: 'local',
    },
  ];

  return (
    <section className="local-data-flow" aria-label="第三方 API 受控连接链路">
      <header className="local-data-flow-heading">
        <div>
          <span>API CONNECTION FLOW</span>
          <h2>第三方 API 优先，由本机 本机能力服务 受控接入</h2>
          <p>真实模型服务由 DeepSeek 等第三方 API 提供；本机 本机能力服务 仅负责会话密钥、策略控制和受控结果回传。</p>
        </div>
        <button className="local-data-flow-action" onClick={onOpenModels} type="button">查看模型连接</button>
      </header>
      <div className="local-data-flow-grid">
        {blocks.map((block) => (
          <article className={`local-data-flow-block ${block.state}`} key={block.eyebrow}>
            <span className="local-data-flow-marker" aria-hidden="true" />
            <div className="local-data-flow-eyebrow">{block.eyebrow}</div>
            <strong>{block.title}</strong>
            <p>{block.description}</p>
          </article>
        ))}
      </div>
      <p className="local-data-flow-note">第三方 API 优先不等于隐式联网：仅当你明确发起模型请求时，本机 本机能力服务 才会向已连接的第三方 API 发送该请求所需数据。</p>
    </section>
  );
}
