import { useEffect, useMemo, useState } from 'react';
import { HttpKnowledgeWorkspaceClient, type WorkbenchKnowledgeImportReceipt, type WorkbenchKnowledgeWorkspace } from '../../runtime/knowledge-workspace-client';

const client = new HttpKnowledgeWorkspaceClient();
function identifier(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 二级设置中的手动知识导入入口。用户只能主动粘贴一段文本，选择范围后由 Gateway 建立可恢复摘要收据。
 * 不显示文件浏览器、不接受路径、不自动读取剪贴板，也不把正文重新回显到导入历史。
 */
export function KnowledgeImportPanel({ gatewayAttached }: { gatewayAttached: boolean }) {
  const [workspaces, setWorkspaces] = useState<readonly WorkbenchKnowledgeWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('default-local');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [budgetMb, setBudgetMb] = useState(25);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<WorkbenchKnowledgeImportReceipt>();
  const activeWorkspaces = useMemo(() => workspaces.filter((workspace) => workspace.status === 'active'), [workspaces]);

  useEffect(() => {
    if (!gatewayAttached) return;
    let disposed = false;
    void client.listWorkspaces()
      .then((items) => {
        if (disposed) return;
        setWorkspaces(items);
        if (!items.some((item) => item.id === workspaceId && item.status === 'active')) setWorkspaceId(items.find((item) => item.status === 'active')?.id ?? '');
      })
      .catch((nextError: unknown) => { if (!disposed) setError(nextError instanceof Error ? nextError.message : '无法读取知识工作区。'); });
    return () => { disposed = true; };
  }, [gatewayAttached, workspaceId]);

  const submit = (): void => {
    const trimmedTitle = title.trim();
    const trimmedText = text.trim();
    const storageBudgetBytes = Math.round(budgetMb * 1024 * 1024);
    if (!gatewayAttached || pending || !workspaceId || !trimmedTitle || !trimmedText || !Number.isSafeInteger(storageBudgetBytes) || storageBudgetBytes < 1) return;
    setPending(true);
    setError(undefined);
    setReceipt(undefined);
    const documentId = identifier('manual-document');
    void client.importText({
      workspaceId,
      importId: identifier('manual-import'),
      documentId,
      title: trimmedTitle,
      sourceUri: `manual://workspace/${workspaceId}/${documentId}`,
      text: trimmedText,
      storageBudgetBytes,
    })
      .then((nextReceipt) => { setReceipt(nextReceipt); setText(''); })
      .catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '知识导入未完成。'))
      .finally(() => setPending(false));
  };

  return (
    <section className="knowledge-import-panel" aria-label="手动知识导入">
      <header><div><span className="panel-eyebrow">EXPLICIT KNOWLEDGE IMPORT</span><h2>导入一段可审查文本</h2><p>只导入你主动粘贴的内容。系统保存摘要、范围和预算收据；不会扫描本地文件、读取剪贴板或上传内容。</p></div><span className={`knowledge-import-status${gatewayAttached ? ' ready' : ''}`}>{gatewayAttached ? 'Gateway 已就绪' : '先附着 Gateway'}</span></header>
      {!gatewayAttached && <p className="knowledge-import-note">此面板需要已附着的本机 Gateway；不会替你启动其他服务。</p>}
      {gatewayAttached && <div className="knowledge-import-form">
        <label><span>工作区范围</span><select title="选择本次文本进入的本地知识工作区；不同工作区使用物理独立索引。" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{activeWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}</select></label>
        <label><span>显示标题</span><input title="仅用于检索引用与审查展示；不会成为文件路径。" maxLength={160} placeholder="例如：产品设计笔记" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>存储预算（MB）</span><input title="本次导入会在进入索引前核对工作区剩余预算。" min={1} max={100} type="number" value={budgetMb} onChange={(event) => setBudgetMb(Number(event.target.value))} /></label>
        <label className="knowledge-import-text"><span>粘贴的文本</span><textarea title="仅提交当前手动粘贴的文本；不读取磁盘文件或剪贴板历史。" maxLength={1_500_000} placeholder="在这里粘贴需要进入当前知识工作区的内容…" value={text} onChange={(event) => setText(event.target.value)} /></label>
        <div className="knowledge-import-footer"><span>{text.length.toLocaleString()} / 1,500,000 字符 · 正文只在本次明确提交时发送至本机 Gateway。</span><button title="创建包含内容摘要、范围、字节预算与分块数量的本地导入收据；不会自动调用模型。" disabled={!gatewayAttached || !workspaceId || !title.trim() || !text.trim() || pending} type="button" onClick={submit}>{pending ? '正在建立收据…' : '导入并建立收据'}</button></div>
      </div>}
      {error && <p className="knowledge-import-error" role="alert">{error}</p>}
      {receipt && <div className="knowledge-import-receipt"><strong>已建立可审查收据</strong><span>{receipt.chunkCount} 个片段 · {receipt.declaredBytes.toLocaleString()} bytes · SHA-256 {receipt.contentDigest.slice(0, 16)}…</span><small>收据 ID：{receipt.importId}。内容不会在此历史卡片中回显。</small></div>}
    </section>
  );
}
