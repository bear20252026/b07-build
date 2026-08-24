import { useState } from 'react';
import type { DirectConversation, DirectConversationCheckpoint } from '../../runtime/use-direct-conversations';

function formatTime(value: number): string { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value); }

export function ConversationCheckpointsPanel({ activeConversation, checkpoints, onCreate, onRestore, onExport }: Readonly<{ activeConversation?: DirectConversation; checkpoints: readonly DirectConversationCheckpoint[]; onCreate(label: string): void; onRestore(id: string): void; onExport(format: 'markdown' | 'json'): void }>) {
  const [label, setLabel] = useState('');
  return <section className="conversation-checkpoints-panel" aria-label="会话检查点">
    <div className="conversation-checkpoints-heading"><div><span>CONVERSATION CHECKPOINTS</span><h2>{activeConversation?.title ?? '尚未选择会话'}</h2><p>检查点与分支均保存在当前 Windows WebView 的本地会话账本。恢复检查点会创建新会话，不会改写原会话。</p></div></div>
    <div className="conversation-checkpoints-create"><label>检查点说明<input disabled={!activeConversation} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="例如：完成需求澄清" value={label} /></label><button disabled={!activeConversation} onClick={() => { onCreate(label); setLabel(''); }} type="button">创建检查点</button></div>
    <div className="conversation-export-actions"><span>导出仅包含可见消息，不含 Provider 隐藏上下文、检索正文、附件数据、密钥或活动内部详情。</span><div><button disabled={!activeConversation} onClick={() => onExport('markdown')} type="button">导出 Markdown</button><button disabled={!activeConversation} onClick={() => onExport('json')} type="button">导出 JSON</button></div></div>
    <div className="conversation-checkpoint-list">{checkpoints.length === 0 ? <p>当前会话尚无检查点。</p> : checkpoints.map((checkpoint) => <article key={checkpoint.id}><div><strong>{checkpoint.label}</strong><span>{formatTime(checkpoint.createdAt)} · {checkpoint.messageCount} 条消息</span></div><button onClick={() => onRestore(checkpoint.id)} type="button">从此检查点新建分支</button></article>)}</div>
  </section>;
}
