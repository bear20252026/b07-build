export interface LocalDataFlowBoardProps {
  gatewayAttached: boolean;
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
 * 它只呈现 App 已拥有的脱敏状态，不能附着 Gateway、读取凭据、发起 Provider 请求或读取文件内容。
 */
export function LocalDataFlowBoard({ gatewayAttached, connectedProviderCount, taskFileCount, onOpenModels }: LocalDataFlowBoardProps) {
  const gatewayTitle = gatewayAttached ? '本机策略边界已就绪' : '等待显式附着';
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
      title: gatewayTitle,
      description: gatewayAttached ? '会话凭据、允许列表、审批和预算策略均在本机 Gateway 内执行。' : '桌面应用不会自动启动后台服务；请在需要时明确附着本机 Gateway。',
      state: gatewayAttached ? 'ready' : 'waiting',
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
    <section className="local-data-flow" aria-label="本地第三方 API 数据流">
      <header className="local-data-flow-heading">
        <div>
          <span>LOCAL DATA FLOW</span>
          <h2>第三方 API，控制权仍在本机</h2>
          <p>第三方模型响应通过本机 Gateway 回到工作台；密钥、任务编排和可恢复记录不离开受控桌面边界。</p>
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
      <p className="local-data-flow-note">本地优先不等于隐藏网络调用：仅当你明确发起模型请求时，本机 Gateway 才会向已连接的第三方 API 发送该请求所需数据。</p>
    </section>
  );
}
