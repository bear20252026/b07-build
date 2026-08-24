import { useEffect, useMemo, useRef, useState } from 'react';
import { indexLocalKnowledge, localKnowledgeDocuments, searchLocalKnowledge, subscribeLocalKnowledge, type LocalKnowledgeDocument } from '../../runtime/local-knowledge-ledger';

const MAX_FILE_CHARS = 512_000;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|ya?ml|toml|csv|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|html?|css|scss|less|tex|xml|svg)$/i;

function readableFile(file: File): boolean { return file.type.startsWith('text/') || TEXT_EXTENSIONS.test(file.name); }
function documentsFor(projectId?: string): readonly LocalKnowledgeDocument[] { return localKnowledgeDocuments(projectId); }

export function LocalKnowledgePanel({ projectId }: Readonly<{ projectId?: string }>) {
  const picker = useRef<HTMLInputElement>(null); const [documents, setDocuments] = useState<readonly LocalKnowledgeDocument[]>(() => documentsFor(projectId));
  const [title, setTitle] = useState(''); const [text, setText] = useState(''); const [query, setQuery] = useState(''); const [notice, setNotice] = useState<string>();
  useEffect(() => { setDocuments(documentsFor(projectId)); return subscribeLocalKnowledge(() => setDocuments(documentsFor(projectId))); }, [projectId]);
  const results = useMemo(() => query.trim() ? searchLocalKnowledge(query, projectId) : documents, [documents, projectId, query]);
  const importText = (): void => { const next = indexLocalKnowledge({ title: title || '未命名手动文本', sourceKind: 'manual-text', text, declaredBytes: new Blob([text]).size, ...(projectId ? { projectId } : {}) }); if (!next) { setNotice('请输入标题和可索引文本后再建立本地索引。'); return; } setTitle(''); setText(''); setNotice(`已在本机建立“${next.title}”的术语索引与来源预览；尚未发送给 Provider。`); };
  const importFiles = async (files: FileList | null): Promise<void> => { const file = files?.[0]; if (!file) return; if (!readableFile(file)) { setNotice('当前 P2 基础只接受主人明确选择的常见文本、代码与结构化文本文件；二进制/PDF/Word 解析将在后续独立导入器中提供。'); return; } const value = (await file.text()).slice(0, MAX_FILE_CHARS); const next = indexLocalKnowledge({ title: file.name, sourceKind: 'selected-file', text: value, declaredBytes: Math.min(file.size, new Blob([value]).size), ...(projectId ? { projectId } : {}) }); setNotice(next ? `已从你选择的文件建立本地索引：${next.title}。只保存有界术语和预览，未上传。` : '文件为空或不可索引。'); if (picker.current) picker.current.value = ''; };
  return <section className="knowledge-import-panel" aria-label="本地知识库">
    <header><div><span className="panel-eyebrow">LOCAL KNOWLEDGE · EXPLICIT</span><h2>本地知识库</h2><p>只处理你明确粘贴或选择的内容。P2 基础仅在当前 Windows WebView 保存有界术语索引与来源预览，不上传、不自动扫描，也不会自动加入 Provider 对话上下文。</p></div><span className="knowledge-import-status ready">仅本机</span></header>
    <div className="knowledge-import-form"><label><span>显示标题</span><input maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品设计笔记" value={title} /></label><label className="knowledge-import-text"><span>手动粘贴文本</span><textarea maxLength={MAX_FILE_CHARS} onChange={(event) => setText(event.target.value)} placeholder="粘贴需要建立本地索引的文本；不会读取剪贴板历史。" value={text} /></label><div className="knowledge-import-footer"><span>{text.length.toLocaleString()} / {MAX_FILE_CHARS.toLocaleString()} 字符 · 索引仅用于本地来源预览。</span><button disabled={!text.trim()} onClick={importText} type="button">建立本地索引</button></div></div>
    <div className="knowledge-import-form"><label><span>选择一个文本或代码文件</span><input accept=".txt,.md,.markdown,.json,.yaml,.yml,.toml,.csv,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rs,.go,.java,.kt,.html,.htm,.css,.scss,.less,.tex,.xml,.svg,text/*" onChange={(event) => { void importFiles(event.target.files); }} ref={picker} type="file" /></label><p className="knowledge-import-note">选择动作只读取本次所选文件；不递归读取文件夹、不保存绝对路径、不上传内容。单文件最多索引 {MAX_FILE_CHARS.toLocaleString()} 字符。</p></div>
    {notice && <p className="knowledge-import-receipt">{notice}</p>}
    <div className="knowledge-import-form"><label><span>本地检索</span><input maxLength={160} onChange={(event) => setQuery(event.target.value)} placeholder="按术语检索已选资料…" value={query} /></label></div>
    <div className="direct-usage-rows">{results.length === 0 ? <p>{query.trim() ? '未找到本地术语匹配。' : '尚未建立本地知识索引。'}</p> : results.map((document) => <article key={document.id}><div><span>{document.sourceKind === 'selected-file' ? '已选文件' : '手动文本'} · {new Date(document.indexedAt).toLocaleString()}</span><strong>{document.title}</strong><small>{document.declaredBytes.toLocaleString()} bytes · {document.termIndex.length} 个本地术语</small></div><dl><div><dt>来源预览</dt><dd>{document.sourcePreview || '—'}</dd></div></dl></article>)}</div>
  </section>;
}
