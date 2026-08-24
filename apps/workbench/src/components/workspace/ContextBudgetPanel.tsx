import { useMemo, useState } from 'react';
import { contextBudget } from '../../runtime/context-budget';
import { projectMemoryClient } from '../../runtime/project-memory-client';
import type { DirectConversation, DirectConversationSelection } from '../../runtime/use-direct-conversations';

function metric(label: string, value: string, detail: string) {
  return <article className="context-budget-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

export function ContextBudgetPanel({ conversation, draft, pendingAttachmentBytes, pendingAttachmentCount, selection }: Readonly<{ conversation?: DirectConversation; draft: string; pendingAttachmentBytes: number; pendingAttachmentCount: number; selection?: DirectConversationSelection }>) {
  const [memory, setMemory] = useState('');
  const [memoryRead, setMemoryRead] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const budget = useMemo(() => contextBudget({ messages: conversation?.messages ?? [], memory, draft, pendingAttachmentBytes }), [conversation?.messages, draft, memory, pendingAttachmentBytes]);
  const readMemory = (): void => { setPending(true); setError(undefined); void projectMemoryClient.read().then((snapshot) => { setMemory(snapshot.content); setMemoryRead(true); }).catch(() => setError('无法读取当前项目记忆。未读取时预算不会将其计入。')).finally(() => setPending(false)); };
  const percentage = `${Math.min(100, Math.round(budget.ratio * 100))}%`;
  return <section className="context-budget-panel" aria-label="上下文预算">
    <div className="context-budget-heading"><div><span>CONTEXT BUDGET · LOCAL ESTIMATE</span><h2>{selection?.model ?? conversation?.selection.model ?? '当前模型尚未选择'}</h2><p>这是桌面端的字符预算投影，不宣称为供应商 token 或账单。打开此面板不会读取文件；只有点击“读取项目记忆”才访问当前工作区。</p></div><button disabled={pending} onClick={readMemory} type="button">{pending ? '读取中…' : '读取项目记忆'}</button></div>
    {error && <p className="context-budget-error" role="alert">{error}</p>}
    <div className="context-budget-hero"><div><span>当前文本预算</span><strong>{percentage}</strong><small>{budget.totalTextCharacters.toLocaleString()} / {budget.limit.toLocaleString()} 字符</small></div><div className={`context-budget-ring ${budget.state}`} aria-label={`预算占用 ${percentage}`}><span>{budget.state === 'near-limit' ? '接近上限' : budget.state === 'watch' ? '留意长度' : '空间充足'}</span></div></div>
    <div className="context-budget-grid">
      {metric('会话历史', budget.historyCharacters.toLocaleString(), `${conversation?.messages.length ?? 0} 条可见消息`)}
      {metric('项目记忆', memoryRead ? budget.memoryCharacters.toLocaleString() : '未读取', memoryRead ? '仅当前 AI_WORK_OS_MEMORY.md' : '点击上方按钮后计算')}
      {metric('待发送草稿', budget.draftCharacters.toLocaleString(), '当前输入框可见文本')}
      {metric('待发送附件', `${pendingAttachmentCount} 个`, `${budget.pendingAttachmentBytes.toLocaleString()} bytes 元数据`)}
    </div>
    <p className="context-budget-note">当真实发送组合超过当前 1M 字符保护预算时，应用会保留最新连续会话内容并在请求前裁剪较早历史。检索正文、图片数据、密钥与完整文件内容不会在本面板展示。</p>
  </section>;
}
