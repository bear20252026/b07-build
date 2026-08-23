import { useEffect, useState } from 'react';
import { projectMemoryClient, type ProjectMemorySnapshot } from '../../runtime/project-memory-client';

function readableError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? '');
  if (code.includes('workspace-not-selected')) return '请先在“工作区与文件”中选择项目目录。';
  if (code.includes('too-large')) return '项目记忆文件超过 256 KB，请精简后重试。';
  return '无法读取或保存项目记忆文件。';
}

export function ProjectMemoryPanel() {
  const [snapshot, setSnapshot] = useState<ProjectMemorySnapshot>();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = (): void => {
    setPending(true); setError(undefined);
    void projectMemoryClient.read().then((next) => { setSnapshot(next); setDraft(next.content); }).catch((nextError: unknown) => setError(readableError(nextError))).finally(() => setPending(false));
  };
  useEffect(refresh, []);

  const save = (): void => {
    setPending(true); setError(undefined);
    void projectMemoryClient.write(draft).then((next) => { setSnapshot(next); setDraft(next.content); }).catch((nextError: unknown) => setError(readableError(nextError))).finally(() => setPending(false));
  };

  return <section className="project-memory-panel" aria-label="项目持久记忆">
    <div className="project-memory-heading"><div><span>PROJECT MEMORY</span><h2>{snapshot?.fileName ?? 'AI_WORK_OS_MEMORY.md'}</h2><p>{snapshot?.selected ? '此 Markdown 文件位于当前选择的工作区。保存后，下一轮聊天会把其内容作为项目上下文传给当前模型。' : '先在“工作区与文件”中选择一个项目目录，再创建或编辑项目记忆。'}</p></div><button disabled={pending} onClick={refresh} type="button">刷新</button></div>
    {error && <p className="project-memory-error" role="alert">{error}</p>}
    <textarea aria-label="项目记忆内容" disabled={!snapshot?.selected || pending} onChange={(event) => setDraft(event.target.value)} placeholder={'# 项目记忆\n\n记录主人明确要求长期保留的事实、约定和决策。'} value={draft} />
    <div className="project-memory-actions"><span>{draft.length.toLocaleString()} / 256,000 bytes</span><button disabled={!snapshot?.selected || pending || draft.length > 256_000} onClick={save} type="button">{pending ? '正在保存…' : '保存到项目记忆'}</button></div>
  </section>;
}
