import { useEffect, useMemo, useRef, useState } from 'react';
import { localKnowledgeDocuments, subscribeLocalKnowledge } from '../../runtime/local-knowledge-ledger';
import type { WorkbenchProject } from '../../runtime/project-client';
import type { DirectConversation } from '../../runtime/use-direct-conversations';
import { projectHaloSearchItems, type HaloSearchAction } from './halo-search-projection';

export interface HaloSearchProps {
  readonly conversations: readonly DirectConversation[];
  readonly projects: readonly WorkbenchProject[];
  onExecute(action: HaloSearchAction): void;
}

/** 本地快速查找只投影已经加载的会话、项目、设置和显式知识库索引，不执行搜索或 Provider 请求。 */
export function HaloSearch({ conversations, projects, onExecute }: HaloSearchProps) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(''); const [selectedIndex, setSelectedIndex] = useState(0); const [knowledgeRevision, refreshKnowledge] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => projectHaloSearchItems({ conversations, projects, knowledge: localKnowledgeDocuments() }, query), [conversations, knowledgeRevision, projects, query]);
  useEffect(() => subscribeLocalKnowledge(() => refreshKnowledge((value) => value + 1)), []);
  useEffect(() => { const onKeyDown = (event: KeyboardEvent): void => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen(true); } if (event.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown); }, []);
  useEffect(() => { if (!open) return; setQuery(''); setSelectedIndex(0); window.setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  useEffect(() => setSelectedIndex((value) => Math.min(value, Math.max(0, results.length - 1))), [results.length]);
  const execute = (index: number): void => { const item = results[index]; if (!item) return; setOpen(false); onExecute(item.action); };
  const grouped = results.reduce<Record<string, typeof results>>((groups, item) => ({ ...groups, [item.group]: [...(groups[item.group] ?? []), item] }), {});
  return <div className="command-palette-root">
    <button aria-label="打开本地快速查找" className="command-palette-trigger halo-search-trigger" onClick={() => setOpen(true)} title="快速查找本地会话、项目、设置与知识库（Ctrl / ⌘ Shift K）" type="button"><span aria-hidden="true">⌕</span><span>查找</span><kbd>⌘ ⇧ K</kbd></button>
    {open && <div className="command-palette-layer" role="presentation" onMouseDown={() => setOpen(false)}><section aria-label="本地快速查找" aria-modal="true" className="command-palette" onMouseDown={(event) => event.stopPropagation()} role="dialog"><div className="command-palette-search"><span aria-hidden="true">⌕</span><input aria-activedescendant={results[selectedIndex] ? `halo-result-${results[selectedIndex].id}` : undefined} aria-controls="halo-search-results" aria-label="快速查找本地会话、项目、设置与知识库" onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex((value) => Math.min(results.length - 1, value + 1)); } if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex((value) => Math.max(0, value - 1)); } if (event.key === 'Enter') { event.preventDefault(); execute(selectedIndex); } }} placeholder="查找会话、项目、设置或本地知识库…" ref={inputRef} role="combobox" value={query} /><kbd>Esc</kbd></div><div className="command-palette-results" id="halo-search-results" role="listbox">{Object.entries(grouped).map(([group, items]) => <section className="command-palette-group" key={group}><span>{group}</span>{items.map((item) => { const index = results.indexOf(item); return <button aria-selected={index === selectedIndex} id={`halo-result-${item.id}`} key={item.id} onClick={() => execute(index)} role="option" type="button"><div><strong>{item.label}</strong><small>{item.description}</small></div><i aria-hidden="true">↵</i></button>; })}</section>)}{results.length === 0 && <p className="command-palette-empty">没有匹配的本地项目；不会查询网络或模型。</p>}</div><footer>只查找当前 WebView 已加载的本地标题与知识库索引；不会发送 Provider 请求、上传文件或执行检索。</footer></section></div>}
  </div>;
}
