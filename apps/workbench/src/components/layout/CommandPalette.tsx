import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchCommand } from './command-catalog';
import { projectWorkbenchCommands } from './command-projection';

export interface CommandPaletteProps {
  commands: readonly WorkbenchCommand[];
  onExecute(command: WorkbenchCommand): void;
}

/**
 * P23 原创本地命令面板。
 *
 * 它只渲染和筛选父组件传入的导航命令。键盘快捷键与点击只会调用 `onExecute`；组件本身不导入
 * Gateway client、不访问文件、Provider、SQLite，也不能成为静默自动化入口。
 */
export function CommandPalette({ commands, onExecute }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => projectWorkbenchCommands(commands, query), [commands, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const execute = (command: WorkbenchCommand): void => {
    setOpen(false);
    onExecute(command);
  };

  return (
    <div className="command-palette-root">
      <button aria-label="打开本地命令面板" className="command-palette-trigger" onClick={() => setOpen(true)} title="命令面板（Ctrl / ⌘ K）" type="button"><span aria-hidden="true">⌕</span><kbd>⌘ K</kbd></button>
      {open && <div className="command-palette-layer" role="presentation" onMouseDown={() => setOpen(false)}>
        <section aria-label="本地命令面板" aria-modal="true" className="command-palette" onMouseDown={(event) => event.stopPropagation()} role="dialog">
          <div className="command-palette-search"><span aria-hidden="true">⌕</span><input aria-label="搜索本地命令" onChange={(event) => setQuery(event.target.value)} placeholder="搜索页面、当前任务或设置…" ref={inputRef} value={query} /><kbd>Esc</kbd></div>
          <div className="command-palette-results">
            {groups.map((group) => <section className="command-palette-group" key={group.group}><span>{group.label}</span>{group.commands.map((command) => <button key={command.id} onClick={() => execute(command)} type="button"><div><strong>{command.label}</strong><small>{command.description}</small></div><i aria-hidden="true">↵</i></button>)}</section>)}
            {groups.length === 0 && <p className="command-palette-empty">没有匹配的本地导航命令。</p>}
          </div>
          <footer>仅含本地导航与焦点操作；不会调用模型、读取文件、执行命令或修改设置。</footer>
        </section>
      </div>}
    </div>
  );
}
