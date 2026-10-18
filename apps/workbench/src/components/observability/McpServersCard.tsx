import { useCallback, useEffect, useState } from 'react';

import {
  loadMcpServerConfigs,
  removeMcpServerConfig,
  saveMcpServerConfig,
  validateMcpServerDraft,
  type McpServerConfigEntry,
} from '../../runtime/mcp-server-config';
import { currentMcpServerRegistry, replaceMcpServerRegistry } from '../../runtime/mcp-servers-store';
import type { McpLiveServerSnapshot } from '../../runtime/zcode/mcp-connection-registry';

/**
 * MCP server 登记与连接。
 *
 * ## 为什么执行的是"用户填的命令"
 *
 * 插件只声明 `mcpApp.serverId`，没有 `command`/`args`。若让插件声明决定本机执行什么，
 * 等于把"装了别人的插件"升级成"跑了别人的命令"。所以这里反过来：**用户自己填命令**，
 * 插件只能按 `serverId` 引用。声明与配置的交集才有意义。
 *
 * ## 为什么不自动连接
 *
 * 连接会 spawn 一个进程。打开设置页就悄悄起一堆进程，是用户没同意的副作用。
 * 每个 server 都要点一次"连接"。
 */
export function McpServersCard() {
  const [configs, setConfigs] = useState<readonly McpServerConfigEntry[]>();
  const [snapshots, setSnapshots] = useState<Readonly<Record<string, McpLiveServerSnapshot>>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ id: '', command: '', args: '', env: '', workingDirectory: '' });

  const reload = useCallback((): void => {
    setError(undefined);
    void loadMcpServerConfigs()
      .then(setConfigs)
      .catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '无法读取 MCP server 配置。'));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // 配置变化 → 重建进程级注册表（旧连接由 store 关掉），并清空本地状态快照。
  useEffect(() => {
    replaceMcpServerRegistry(configs ?? []);
    setSnapshots({});
  }, [configs]);

  const parseLines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter(Boolean);
  const parseEnv = (text: string): [string, string][] => parseLines(text).map((line) => {
    const at = line.indexOf('=');
    return at < 0 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1)];
  });

  const onSave = (): void => {
    const problem = validateMcpServerDraft({ id: draft.id, command: draft.command, env: parseEnv(draft.env) });
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(undefined);
    void saveMcpServerConfig({
      id: draft.id.trim(),
      command: draft.command.trim(),
      args: parseLines(draft.args),
      env: parseEnv(draft.env),
      ...(draft.workingDirectory.trim() ? { workingDirectory: draft.workingDirectory.trim() } : {}),
    })
      .then((next) => { setConfigs(next); setDraft({ id: '', command: '', args: '', env: '', workingDirectory: '' }); })
      .catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '保存失败。'))
      .finally(() => setBusy(false));
  };

  const onRemove = (id: string): void => {
    setBusy(true);
    void removeMcpServerConfig(id)
      .then(setConfigs)
      .catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '删除失败。'))
      .finally(() => setBusy(false));
  };

  const onConnect = (id: string): void => {
    setSnapshots((current) => ({ ...current, [id]: { serverId: id, state: 'connecting', toolNames: [] } }));
    void currentMcpServerRegistry().connect(id).then((snapshot) => setSnapshots((current) => ({ ...current, [id]: snapshot })));
  };

  const statusText = (entry: McpServerConfigEntry): string => {
    if (!entry.enabled) return '已停用';
    const snapshot = snapshots[entry.id];
    if (!snapshot) return '未连接';
    if (snapshot.state === 'connecting') return '连接中…';
    if (snapshot.state === 'ready') return `已连接 · ${snapshot.toolNames.length} 个工具`;
    return `连接失败：${snapshot.error === 'no-session-spec' ? '缺少启动配置' : snapshot.error ?? '未知原因'}`;
  };

  return (
    <section className="extension-center" aria-label="MCP server 登记">
      <header className="extension-center-heading">
        <div>
          <div className="extension-center-eyebrow">MCP SERVERS</div>
          <h2>MCP server</h2>
        </div>
        <button className="extension-refresh" disabled={busy} onClick={reload} type="button">刷新</button>
      </header>
      <p className="extension-center-empty">
        这里登记的是<strong>你自己填的</strong>命令。插件只按 serverId 引用，不能声明要跑什么 —— 执行的永远是本页配置。
      </p>
      {error && <p className="extension-center-error" role="alert">{error}</p>}

      {configs && configs.length === 0 && <p className="extension-center-empty">还没有登记任何 server。</p>}
      {configs && configs.length > 0 && <ul className="extension-list">{configs.map((entry) => <li className="extension-item" key={entry.id}>
        <div>
          <strong>{entry.id}</strong>
          <code>{entry.command}{entry.args.length > 0 ? ` ${entry.args.join(' ')}` : ''}</code>
          <span className={`extension-status ${snapshots[entry.id]?.state === 'ready' ? 'installed' : ''}`}>{statusText(entry)}</span>
        </div>
        <div className="extension-item-actions">
          <button disabled={busy || !entry.enabled || snapshots[entry.id]?.state === 'connecting'} onClick={() => onConnect(entry.id)} type="button">连接</button>
          <button disabled={busy} onClick={() => onRemove(entry.id)} type="button">删除</button>
        </div>
      </li>)}</ul>}

      <details className="extension-center-details">
        <summary>登记新 server</summary>
        <div className="mcp-server-form">
          <label>id<input onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="filesystem" value={draft.id} /></label>
          <label>命令<input onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" value={draft.command} /></label>
          <label>参数（每行一个）<textarea onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:/work'} value={draft.args} /></label>
          <label>环境变量（每行 KEY=VALUE）<textarea onChange={(event) => setDraft({ ...draft, env: event.target.value })} value={draft.env} /></label>
          <label>工作目录（可选）<input onChange={(event) => setDraft({ ...draft, workingDirectory: event.target.value })} value={draft.workingDirectory} /></label>
          <button disabled={busy} onClick={onSave} type="button">保存</button>
        </div>
      </details>
    </section>
  );
}
