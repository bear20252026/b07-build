import { useCallback, useEffect, useState } from 'react';
import { loadInstalledPluginCatalog, type InstalledPluginCatalogEntry } from '../../runtime/plugin-reference-catalog';

/**
 * 已安装插件（来自插件市场账本）。
 *
 * ## 这个面板替换了什么
 *
 * 原来这里是 `ExtensionCenter`，它通过 HTTP 读 `/api/extensions` —— 那个服务
 * （`apps/runtime-gateway`）在 2026-08-26 被删除，于是面板永远停在"读取失败"。
 *
 * 现在读的是**真实存在的账本**：插件由 `tools/plugin-marketplace-cli.ts` 装进
 * `~/.awo/plugin-marketplace/*.sqlite`，这里通过 Tauri 命令只读地把它列出来。
 *
 * ## 必须说清的语义
 *
 * 显示的是插件**声明**的能力（server id、请求的工具名），**不代表已连接或可用**。
 * 把它当成可用，会让人以为模型能调那些工具。所以界面上直接写"声明值"。
 */
export function InstalledPluginCatalogCard() {
  const [entries, setEntries] = useState<readonly InstalledPluginCatalogEntry[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const reload = useCallback((): void => {
    setLoading(true);
    setError(undefined);
    void loadInstalledPluginCatalog()
      .then(setEntries)
      .catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取插件账本。'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const totalTools = (entries ?? []).reduce((sum, entry) => sum + entry.requestedToolNames.length, 0);

  return (
    <section className="extension-center" aria-label="已安装插件">
      <header className="extension-center-heading">
        <div>
          <div className="extension-center-eyebrow">INSTALLED PLUGINS</div>
          <h2>已安装插件</h2>
        </div>
        <button className="extension-refresh" disabled={loading} onClick={reload} type="button">{loading ? '读取中…' : '刷新'}</button>
      </header>
      <p className="extension-center-empty">来自插件市场账本（只读）。下面显示的是插件<strong>声明</strong>的能力，不代表已连接或可用。</p>
      {error && <p className="extension-center-error" role="alert">读取失败：{error}</p>}
      {!error && entries && entries.length === 0 && <p className="extension-center-empty">账本里还没有插件。用 <code>node --experimental-sqlite --import tsx tools/plugin-marketplace-cli.ts add &lt;source&gt;</code> 安装后回来刷新。</p>}
      {!error && entries && entries.length > 0 && <>
        <p className="extension-center-empty">{entries.length} 个插件 · 共声明 {totalTools} 个工具</p>
        <ul className="extension-list">{entries.map((entry) => <li className="extension-item" key={entry.pluginId}>
          <div>
            <strong>{entry.name}</strong>
            <code>{entry.pluginId}</code>
            <span className="extension-status installed">{entry.version || '未知版本'}</span>
          </div>
          <small>
            {entry.mcpServerId ? `声明 MCP server：${entry.mcpServerId}` : '未声明 MCP server'}
            {entry.requestedToolNames.length > 0 ? ` · 声明工具：${entry.requestedToolNames.join('、')}` : ' · 无声明工具'}
          </small>
        </li>)}</ul>
      </>}
    </section>
  );
}
