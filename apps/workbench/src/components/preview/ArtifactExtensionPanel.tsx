import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchTaskFile, WorkbenchTaskFilePreview } from '../../runtime/task-client';
import type { AssistantArtifactEntry } from '../../runtime/assistant-artifact-ledger';
import { projectArtifactRailEntries, projectArtifactRailTree, type ArtifactRailEntry, type ArtifactRailTreeNode } from './artifact-extension-projection';

const ARTIFACT_EXTENSION_STYLE = `.artifact-extension{position:relative;min-width:0;min-height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr);border-left:1px solid var(--border);background:var(--panel-subtle)}.artifact-extension-resizer{position:absolute;z-index:2;top:0;bottom:0;left:-5px;width:10px;cursor:col-resize;touch-action:none}.artifact-extension-resizer:focus-visible,.artifact-extension-resizer:hover{border-left:2px solid var(--accent);outline:0}.artifact-extension-header{min-height:68px;padding:13px 15px;display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--border)}.artifact-extension-header span,.artifact-extension-preview-heading span{color:var(--muted);font-size:9px;font-weight:700;letter-spacing:.08em}.artifact-extension-header strong{display:block;margin-top:3px;color:var(--text-strong);font-size:13px}.artifact-extension-header p,.artifact-extension-empty,.artifact-extension-error,.artifact-extension-boundary{margin:3px 0 0;color:var(--muted);font-size:10px;line-height:1.45}.artifact-extension-header button{width:25px;height:25px;padding:0;color:var(--muted-strong);border:1px solid var(--border);border-radius:8px;background:var(--panel)}.artifact-extension-content{min-height:0;display:grid;grid-template-rows:minmax(116px,.42fr) minmax(0,.58fr)}.artifact-extension-tree,.artifact-extension-preview{min-height:0;overflow:auto;padding:12px}.artifact-extension-tree{border-bottom:1px solid var(--border)}.artifact-extension-tree-heading{display:flex;justify-content:space-between;padding-bottom:7px;color:var(--muted);font-size:10px;font-weight:700}.artifact-extension-tree-heading b{padding:2px 6px;color:var(--accent-strong);border-radius:99px;background:var(--accent-soft)}.artifact-extension-entry{width:100%;min-width:0;margin-top:4px;padding:7px;display:grid;grid-template-columns:26px minmax(0,1fr);gap:7px;color:var(--muted-strong);text-align:left;border:1px solid transparent;border-radius:10px;background:transparent}.artifact-extension-entry:hover,.artifact-extension-entry.selected{color:var(--text-strong);border-color:var(--border);background:var(--panel)}.artifact-extension-entry.selected{border-color:var(--accent)}.artifact-extension-entry>span{padding:4px 2px;color:var(--accent-strong);font:700 9px/1 var(--font-mono);text-align:center;border:1px solid var(--border);border-radius:5px;background:var(--accent-soft)}.artifact-extension-entry i{min-width:0;display:grid;gap:2px;font-style:normal}.artifact-extension-entry strong,.artifact-extension-entry small,.artifact-extension-preview-heading small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.artifact-extension-entry strong{font-size:11px}.artifact-extension-entry small,.artifact-extension-preview-heading small{color:var(--muted);font-size:9px}.artifact-extension-preview-heading{display:grid;gap:3px;padding-bottom:8px}.artifact-extension-preview pre{min-height:100%;margin:0;padding:9px;overflow:auto;color:var(--text-strong);font:10px/1.55 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--border);border-radius:8px;background:var(--panel)}.artifact-extension-error{padding:8px;color:var(--danger);border:1px solid var(--danger);border-radius:8px;background:var(--danger-soft)}.artifact-extension-boundary{padding-top:7px;color:var(--warning);border-top:1px solid var(--border)}`;

export interface ArtifactExtensionPanelProps {
  taskFiles: readonly WorkbenchTaskFile[];
  assistantArtifacts: readonly AssistantArtifactEntry[];
  width: number;
  onClose(): void;
  onResize(width: number): void;
  onPreviewTaskFile(taskFileId: string): Promise<WorkbenchTaskFilePreview>;
  onPreviewAssistantArtifact(entry: AssistantArtifactEntry): Promise<Readonly<{ content: string; logicalPath: string; byteSize: number; truncated: boolean }>>;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function sourceLabel(entry: ArtifactRailEntry): string {
  return entry.kind === 'assistant' ? '已确认保存的回复' : '任务 / 运行回执';
}

type TreeRow = Readonly<{ node: ArtifactRailTreeNode; depth: number }>;

function visibleTreeRows(nodes: readonly ArtifactRailTreeNode[], expanded: ReadonlySet<string>, depth = 0): readonly TreeRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.folder && expanded.has(node.id) ? visibleTreeRows(node.children, expanded, depth + 1) : []),
  ]);
}

function collectFolderIds(nodes: readonly ArtifactRailTreeNode[]): readonly string[] {
  return nodes.flatMap((node) => node.folder ? [node.id, ...collectFolderIds(node.children)] : []);
}

export function ArtifactExtensionPanel({ taskFiles, assistantArtifacts, width, onClose, onResize, onPreviewTaskFile, onPreviewAssistantArtifact }: ArtifactExtensionPanelProps) {
  const entries = useMemo(() => projectArtifactRailEntries(taskFiles, assistantArtifacts), [taskFiles, assistantArtifacts]);
  const tree = useMemo(() => projectArtifactRailTree(entries), [entries]);
  const [selectedId, setSelectedId] = useState<string>();
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = useState<Readonly<{ logicalPath: string; content: string; byteSize: number; truncated: boolean }>>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const dragStart = useRef<Readonly<{ x: number; width: number }> | undefined>(undefined);

  useEffect(() => {
    setSelectedId((current) => current && entries.some((entry) => entry.id === current) ? current : entries[0]?.id);
  }, [entries]);
  useEffect(() => {
    setExpandedFolders((current) => new Set([...current, ...collectFolderIds(tree)]));
  }, [tree]);
  const rows = useMemo(() => visibleTreeRows(tree, expandedFolders), [expandedFolders, tree]);

  const load = async (entry: ArtifactRailEntry): Promise<void> => {
    setSelectedId(entry.id);
    setLoading(true);
    setError(undefined);
    try {
      if (entry.kind === 'task') {
        const file = taskFiles.find((item) => `task:${item.taskFileId}` === entry.id);
        if (!file) return;
        const result = await onPreviewTaskFile(file.taskFileId);
        setPreview({ logicalPath: result.logicalPath, content: result.content, byteSize: result.byteSize, truncated: result.truncated });
      } else {
        const file = assistantArtifacts.find((item) => `assistant:${item.artifactId}` === entry.id);
        if (!file) return;
        setPreview(await onPreviewAssistantArtifact(file));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取受控产物预览。');
    } finally {
      setLoading(false);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, width };
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (!start) return;
    onResize(Math.max(300, Math.min(560, start.width - (event.clientX - start.x))));
  };
  const stopResize = (): void => { dragStart.current = undefined; };
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); onResize(width + 16); }
    if (event.key === 'ArrowRight') { event.preventDefault(); onResize(width - 16); }
    if (event.key === 'Home') { event.preventDefault(); onResize(300); }
    if (event.key === 'End') { event.preventDefault(); onResize(560); }
  };
  const toggleFolder = (folderId: string): void => setExpandedFolders((current) => {
    const next = new Set(current);
    if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
    return next;
  });

  return <aside aria-label="项目产物扩展框" className="artifact-extension" style={{ width }}>
    <style>{ARTIFACT_EXTENSION_STYLE}</style>
    <div aria-label="拖动或使用左右方向键调整项目产物扩展框宽度" aria-orientation="vertical" aria-valuemax={560} aria-valuemin={300} aria-valuenow={width} className="artifact-extension-resizer" onKeyDown={resizeWithKeyboard} onPointerDown={startResize} onPointerMove={resize} onPointerUp={stopResize} role="separator" tabIndex={0} />
    <header className="artifact-extension-header"><div><span>PROJECT ARTIFACTS</span><strong>项目产物</strong><p>仅显示已有受控回执和你确认保存的 Markdown 回复。</p></div><button aria-label="关闭项目产物扩展框" onClick={onClose} type="button">×</button></header>
    <div className="artifact-extension-content">
      <section aria-label="受控产物树" className="artifact-extension-tree" role="tree">
        <div className="artifact-extension-tree-heading"><span>受控产物</span><b>{entries.length}</b></div>
        {entries.length === 0 ? <p className="artifact-extension-empty">尚无可展示的受控产物。普通聊天文本不会自动写入文件；可在已完成的 AI 回复下明确点击“保存为 MD”。</p> : rows.map(({ node, depth }) => node.folder ? <button aria-expanded={expandedFolders.has(node.id)} className="artifact-extension-entry artifact-extension-folder" key={node.id} onClick={() => toggleFolder(node.id)} role="treeitem" style={{ paddingInlineStart: `${7 + depth * 16}px` }} type="button"><span aria-hidden="true">{expandedFolders.has(node.id) ? '⌄' : '›'}</span><i><strong>{node.name}</strong><small>受控路径分组</small></i></button> : node.entry ? <button aria-selected={selectedId === node.entry.id} className={`artifact-extension-entry${selectedId === node.entry.id ? ' selected' : ''}`} key={node.id} onClick={() => void load(node.entry!)} role="treeitem" style={{ paddingInlineStart: `${7 + depth * 16}px` }} title={`${sourceLabel(node.entry)} · ${node.entry.logicalPath}`} type="button"><span aria-hidden="true">{node.entry.kind === 'assistant' ? 'MD' : '▧'}</span><i><strong>{node.name}</strong><small>{node.entry.summary}</small></i></button> : null)}
      </section>
      <section aria-label="受控产物预览" className="artifact-extension-preview">
        <div className="artifact-extension-preview-heading"><span>READ ONLY PREVIEW</span><small>{preview ? `${formatBytes(preview.byteSize)} · ${preview.logicalPath}` : '按需加载'}</small></div>
        {error ? <p className="artifact-extension-error" role="alert">{error}</p> : loading ? <p className="artifact-extension-empty">正在读取受控预览…</p> : preview ? <><pre><code>{preview.content}</code></pre>{preview.truncated && <p className="artifact-extension-boundary">预览已限制到本地安全上限；文件未被自动执行或上传。</p>}</> : <p className="artifact-extension-empty">选择一项产物以按需读取受限预览。打开扩展框本身不会扫描目录或触发 Provider 请求。</p>}
      </section>
    </div>
  </aside>;
}
