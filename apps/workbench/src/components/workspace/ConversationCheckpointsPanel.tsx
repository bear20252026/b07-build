import { useState } from 'react';
import type { DirectConversation, DirectConversationCheckpoint } from '../../runtime/use-direct-conversations';
import { describeFileRewindPlan } from '../../runtime/workspace-file-rewind';
import type { FileRewindPlan } from '../../runtime/workspace-file-rewind-contract';

function formatTime(value: number): string { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value); }

/**
 * 会话检查点面板。
 *
 * 两件**不同**的事，界面上必须分开：
 * - 「从此检查点新建分支」只改对话，不碰文件；
 * - 「回退文件到此时」只改文件，不碰对话 —— 而且它是破坏性的，所以先出预览再落盘。
 *
 * 把两者合成一个按钮是常见的错误：用户想撤掉对话时会连带丢掉文件改动，
 * 或者反过来以为文件已经回去了。
 */
export function ConversationCheckpointsPanel({ activeConversation, checkpoints, onCreate, onRestore, onExport, onPreviewFileRewind, onApplyFileRewind }: Readonly<{
  activeConversation?: DirectConversation;
  checkpoints: readonly DirectConversationCheckpoint[];
  onCreate(label: string): void;
  onRestore(id: string): void;
  onExport(format: 'markdown' | 'json'): void;
  /** 预览文件回退（只读）。 */
  onPreviewFileRewind(id: string): Promise<FileRewindPlan>;
  /** 落盘文件回退，返回可直接展示的一句话。 */
  onApplyFileRewind(id: string, plan: FileRewindPlan): Promise<string>;
}>) {
  const [label, setLabel] = useState('');
  /** 当前展开预览的检查点 id。同一时刻只展开一个：两个预览并排会让人分不清在确认哪个。 */
  const [previewId, setPreviewId] = useState<string>();
  const [preview, setPreview] = useState<FileRewindPlan>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  const previewFor = async (id: string): Promise<void> => {
    if (busy) return;
    setBusy(true); setNote(undefined); setPreview(undefined); setPreviewId(id);
    try {
      setPreview(await onPreviewFileRewind(id));
    } catch (error: unknown) {
      setNote(error instanceof Error ? error.message : '无法读取该检查点的文件状态。');
      setPreviewId(undefined);
    } finally {
      setBusy(false);
    }
  };

  const applyFor = async (id: string): Promise<void> => {
    if (busy || !preview) return;
    setBusy(true);
    try {
      setNote(await onApplyFileRewind(id, preview));
      // 落盘之后计划就过期了：留着它会让用户以为还能再点一次。
      setPreview(undefined); setPreviewId(undefined);
    } catch (error: unknown) {
      setNote(error instanceof Error ? error.message : '回退失败。');
    } finally {
      setBusy(false);
    }
  };

  return <section className="conversation-checkpoints-panel" aria-label="会话检查点">
    <div className="conversation-checkpoints-heading"><div><span>CONVERSATION CHECKPOINTS</span><h2>{activeConversation?.title ?? '尚未选择会话'}</h2><p>检查点与分支均保存在当前 Windows WebView 的本地会话账本。恢复检查点会创建新会话，不会改写原会话；回退文件会改写工作区，需逐文件确认。</p></div></div>
    <div className="conversation-checkpoints-create"><label>检查点说明<input disabled={!activeConversation} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="例如：完成需求澄清" value={label} /></label><button disabled={!activeConversation} onClick={() => { onCreate(label); setLabel(''); }} type="button">创建检查点</button></div>
    <div className="conversation-export-actions"><span>导出仅包含可见消息，不含 Provider 隐藏上下文、检索正文、附件数据、密钥或活动内部详情。</span><div><button disabled={!activeConversation} onClick={() => onExport('markdown')} type="button">导出 Markdown</button><button disabled={!activeConversation} onClick={() => onExport('json')} type="button">导出 JSON</button></div></div>
    {note && <p className="conversation-checkpoints-note">{note}</p>}
    <div className="conversation-checkpoint-list">{checkpoints.length === 0 ? <p>当前会话尚无检查点。</p> : checkpoints.map((checkpoint) => <article key={checkpoint.id}>
      <div><strong>{checkpoint.label}</strong><span>{formatTime(checkpoint.createdAt)} · {checkpoint.messageCount} 条消息</span></div>
      <div className="conversation-checkpoint-actions">
        <button onClick={() => onRestore(checkpoint.id)} type="button">从此检查点新建分支</button>
        <button disabled={busy} onClick={() => void previewFor(checkpoint.id)} type="button">{previewId === checkpoint.id && busy ? '读取中…' : '回退文件到此时'}</button>
      </div>
      {previewId === checkpoint.id && preview && <div className="conversation-checkpoint-rewind">
        <pre>{describeFileRewindPlan(preview)}</pre>
        <div>
          <button disabled={busy || !preview.canApply} onClick={() => void applyFor(checkpoint.id)} type="button">{busy ? '回退中…' : '确认回退文件'}</button>
          <button disabled={busy} onClick={() => { setPreview(undefined); setPreviewId(undefined); setNote(undefined); }} type="button">取消</button>
        </div>
      </div>}
    </article>)}</div>
  </section>;
}
