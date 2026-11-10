import { useEffect, useMemo, useRef, useState } from 'react';

import type { InstalledPluginCatalogEntry } from '../../runtime/plugin-reference-catalog';
import { buildPluginMentionCatalog, type PluginMentionCandidate } from '../../runtime/plugin-mention-catalog';
import type { McpServerStatus } from '../../runtime/mcp-servers-store';

/**
 * `@` 引用选择器。
 *
 * ## 它解决的问题
 *
 * 插件能力提示要求用户消息里出现 `[label](plugin://name@marketplace)`。手写这套语法
 * 不现实 —— 用户既不知道 stable id 的确切拼写（拼错了引用会被跳过），也不知道
 * 哪个插件此刻真的可用。picker 把这两件事都挡掉：**候选来自数据，插入的是完整标记**。
 *
 * ## 为什么列出"未就绪"的插件
 *
 * 只列可用的会让用户以为"没装"，而真相可能是"装了但没连上"或"没在设置里登记 server"。
 * 所以未就绪的也列出来，但**明确标注原因与下一步** —— 它们是信息，不是可选项。
 *
 * ## 不做的事
 *
 * - **不自动插入**：用户必须主动选。`@` 触发只是展开候选，不代表同意引用。
 * - **不因为某个候选不可用就隐藏它**：隐藏等于把"装了但没连上"伪装成"没装"。
 * - **不读插件账本之外的东西**：候选只来自已安装目录与连接状态，不探测、不重连。
 */

/** 从输入框转发来的按键；`seq` 用于区分同一颗键的连续两次。 */
export interface ForwardedPluginMentionKey {
  readonly key: string;
  readonly seq: number;
}

export interface PluginMentionPickerProps {
  readonly installed: readonly InstalledPluginCatalogEntry[];
  readonly servers: readonly McpServerStatus[];
  /** 用户当前输入，用于按 stable id / 显示名过滤。 */
  readonly query: string;
  /**
   * 从输入框转发来的按键（`{ key, seq }`，`seq` 用于区分同一颗键的连续两次）。
   *
   * 为什么不让 picker 自己监听 keydown：焦点在 textarea 上，picker 收不到按键。
   * 而把 picker 做成可聚焦元素会夺走输入焦点，用户就没法边选边打字了。
   */
  readonly forwardedKey?: ForwardedPluginMentionKey;
  onSelect(candidate: PluginMentionCandidate): void;
  onClose(): void;
}

const REASON_TEXT: Record<Exclude<PluginMentionCandidate['reason'], undefined>, string> = {
  no_declared_server: '该插件没有声明 MCP server',
  server_not_configured: '未在设置里登记这个 server',
  not_connected: '未连接',
  no_visible_tools: '已连接但没有可见工具',
  invalid_identifier: '插件标识符不合法',
};

export function PluginMentionPicker({ installed, servers, query, forwardedKey, onSelect, onClose }: PluginMentionPickerProps) {
  const catalog = useMemo(() => buildPluginMentionCatalog({ installed, servers }), [installed, servers]);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalog.candidates;
    return catalog.candidates.filter((candidate) =>
      candidate.stableId.toLowerCase().includes(needle) || candidate.label.toLowerCase().includes(needle));
  }, [catalog.candidates, query]);

  useEffect(() => { setActiveIndex(0); }, [query]);

  // 键盘：只在当前高亮项**可用**时响应 Enter。不可用的项按 Enter 不应当选中 ——
  // 选中一个引用了也没用的插件，等于把"未连接"包装成"已引用"。
  useEffect(() => {
    if (!forwardedKey) return;
    if (forwardedKey.key === 'ArrowDown') {
      setActiveIndex((current) => (filtered.length === 0 ? 0 : (current + 1) % filtered.length));
      return;
    }
    if (forwardedKey.key === 'ArrowUp') {
      setActiveIndex((current) => (filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length));
      return;
    }
    if (forwardedKey.key === 'Enter') {
      const candidate = filtered[activeIndex] ?? filtered[0];
      // 不可用的候选按 Enter 不选中：引用一个连不上的插件，等于把"未连接"包装成"已引用"。
      if (candidate && candidate.readiness === 'available') onSelect(candidate);
    }
  }, [forwardedKey, filtered, activeIndex, onSelect]);

  useEffect(() => {
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (filtered.length === 0) {
    return <div className="plugin-mention-picker" role="listbox" aria-label="插件引用候选">
      <p className="plugin-mention-empty">
        {catalog.empty
          ? '还没有安装任何插件。插件装好后，这里会列出可引用的插件。'
          : `没有匹配“${query.trim()}”的插件。`}
      </p>
      <div className="plugin-mention-footer"><button onClick={onClose} type="button">关闭</button></div>
    </div>;
  }

  return <div className="plugin-mention-picker" role="listbox" aria-label="插件引用候选" aria-activedescendant={`plugin-mention-${activeIndex}`}>
    <ul ref={listRef}>
      {filtered.map((candidate, index) => {
        const usable = candidate.readiness === 'available';
        return <li
          aria-disabled={!usable}
          aria-selected={index === activeIndex}
          className={`plugin-mention-item${index === activeIndex ? ' is-active' : ''}${usable ? '' : ' is-blocked'}`}
          id={`plugin-mention-${index}`}
          key={candidate.stableId}
          onClick={(): void => { if (usable) onSelect(candidate); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && usable) { event.preventDefault(); onSelect(candidate); }
          }}
          onMouseEnter={(): void => setActiveIndex(index)}
          role="option"
          tabIndex={-1}
        >
          <span className="plugin-mention-label">{candidate.label}</span>
          <code className="plugin-mention-id">{candidate.stableId}</code>
          <span className={`plugin-mention-status ${usable ? 'ready' : 'blocked'}`}>
            {usable ? `可用 · ${candidate.liveServerNames.join(', ')}` : REASON_TEXT[candidate.reason ?? 'no_declared_server']}
          </span>
        </li>;
      })}
    </ul>
    <div className="plugin-mention-footer">
      <span>↑↓ 选择 · Enter 插入 · Esc 关闭</span>
      <button onClick={onClose} type="button">关闭</button>
    </div>
  </div>;
}

/** 从输入框的光标位置解析 `@` 查询与插入范围。 */
export interface PluginMentionQuery {
  /** 当前 `@` 后面已经输入的字符（不含 `@`）。 */
  readonly query: string;
  /** 需要被替换掉的 `@...` 段（含 `@`）的起止下标。 */
  readonly start: number;
  readonly end: number;
}

/**
 * 取光标前最近一个未闭合的 `@`。
 *
 * 只认"光标紧邻的 `@` 段"：`@foo bar` 之后光标在 bar 后面时不该继续触发 ——
 * 那是正文里的 `@`，不是引用。判断标准是 `@` 与光标之间只允许名字字符。
 */
export function readPluginMentionQuery(text: string, cursor: number): PluginMentionQuery | undefined {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)@([A-Za-z0-9._@-]*)$/.exec(before);
  if (!match) return undefined;
  const start = match.index + match[0].indexOf('@');
  return { query: match[1] ?? '', start, end: cursor };
}
