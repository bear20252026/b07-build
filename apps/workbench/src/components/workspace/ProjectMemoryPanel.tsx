import { useState } from 'react';
import { projectMemoryClient, type ProjectMemorySnapshot } from '../../runtime/project-memory-client';
import { proposalPreview, proposedMemoryContent } from '../../runtime/project-memory-proposal';

function readableError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? '');
  if (code.includes('workspace-not-selected')) return '请先在“工作区与文件”中选择项目目录。';
  if (code.includes('too-large')) return '项目记忆文件超过 256 KB，请精简后重试。';
  return '无法读取或保存项目记忆文件。';
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function ProjectMemoryPanel() {
  const [snapshot, setSnapshot] = useState<ProjectMemorySnapshot>();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [proposal, setProposal] = useState('');
  const [proposalOpen, setProposalOpen] = useState(false);
  const [approved, setApproved] = useState(false);

  const refresh = (): void => {
    setPending(true); setError(undefined);
    void projectMemoryClient.read().then((next) => { setSnapshot(next); setDraft(next.content); }).catch((nextError: unknown) => setError(readableError(nextError))).finally(() => setPending(false));
  };

  const save = (): void => {
    setPending(true); setError(undefined);
    void projectMemoryClient.write(draft).then((next) => { setSnapshot(next); setDraft(next.content); }).catch((nextError: unknown) => setError(readableError(nextError))).finally(() => setPending(false));
  };
  const approveProposal = (): void => {
    if (!snapshot?.selected || !approved || !proposal.trim()) return;
    const next = proposedMemoryContent(draft, proposal);
    setPending(true); setError(undefined);
    void projectMemoryClient.write(next).then((saved) => { setSnapshot(saved); setDraft(saved.content); setProposal(''); setApproved(false); setProposalOpen(false); }).catch((nextError: unknown) => setError(readableError(nextError))).finally(() => setPending(false));
  };

  return <section className="project-memory-panel" aria-label="项目持久记忆">
    <div className="project-memory-heading"><div><span>PROJECT MEMORY · WHITE BOX</span><h2>{snapshot?.fileName ?? 'AI_WORK_OS_MEMORY.md'}</h2><p>{snapshot?.selected ? '此 Markdown 文件位于当前选择的工作区。主人直接编辑与 AI/主人提出的记忆增量分开呈现；保存后，下一轮聊天才会读取其内容。' : '打开面板不会读取文件。请先在“工作区与文件”中选择项目，再点击“读取记忆”。'}</p></div><button disabled={pending} onClick={refresh} type="button">{pending ? '读取中…' : '读取记忆'}</button></div>
    {error && <p className="project-memory-error" role="alert">{error}</p>}
    <textarea aria-label="项目记忆内容" disabled={!snapshot?.selected || pending} onChange={(event) => setDraft(event.target.value)} placeholder={'# 项目记忆\n\n记录主人明确要求长期保留的事实、约定和决策。'} value={draft} />
    <div className="project-memory-actions"><span>{utf8Bytes(draft).toLocaleString()} / 256,000 bytes</span><button disabled={!snapshot?.selected || pending || utf8Bytes(draft) > 256_000} onClick={save} type="button">{pending ? '正在保存…' : '保存到项目记忆'}</button></div>
    <section className="project-memory-proposal"><div><span>MEMORY PROPOSAL</span><strong>AI/主人提议必须由主人批准</strong><p>提议只在本地预览；不会自动写入文件、不会发送给模型，也不会覆盖现有记忆。</p></div><button disabled={!snapshot?.selected || pending} onClick={() => setProposalOpen((value) => !value)} type="button">{proposalOpen ? '收起提议' : '创建记忆提议'}</button>{proposalOpen && <><textarea aria-label="记忆提议内容" disabled={pending} onChange={(event) => setProposal(event.target.value)} placeholder="例如：本项目使用当前选中的 Provider 直连；提交代码前必须由主人确认。" value={proposal} /><pre>{proposalPreview(draft, proposal).join('\n')}</pre><label><input checked={approved} disabled={!proposal.trim() || pending} onChange={(event) => setApproved(event.target.checked)} type="checkbox" />我已查看这项记忆提议，并确认将其追加到项目 Markdown 文件。</label><button className="project-memory-approve" disabled={!approved || !proposal.trim() || pending} onClick={approveProposal} type="button">批准并追加记忆</button></>}</section>
  </section>;
}
