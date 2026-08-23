import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFilePreferencesV1 } from '../../runtime/workspace-file-contract';
import { cancelTerminalCommand, startTerminalCommand, type TerminalDoneEvent, type TerminalOutputEvent } from '../../runtime/terminal-client';

const HIGH_IMPACT = /rm\s+-rf|remove-item|del\s+\/|rmdir\s+\/|format\s|diskpart|shutdown|restart-computer|stop-computer|reg\s+delete|git\s+push\s+--force|runas|start-process\s+-verb\s+runas/i;
const EXAMPLES = ['npm test', 'npm run build', 'cargo check', 'git status'];

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (text.includes('terminal-command-confirmation-required')) return '该命令可能删除、提权或产生不可逆系统副作用。请勾选最后确认后再运行。';
  if (text.includes('terminal-command-spawn-failed')) return 'Windows 无法启动命令解释器。请检查本机环境。';
  return text && !/[<{]/.test(text) ? text : '终端命令未能启动。';
}

/** 用户显式触发的本地终端。不会从模型回复、网页或附件中自动取得命令。 */
export function TerminalCodingPage({ workspace }: { workspace: WorkspaceFilePreferencesV1 }) {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState<readonly TerminalOutputEvent[]>([]);
  const [runId, setRunId] = useState<string>();
  const [done, setDone] = useState<TerminalDoneEvent>();
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const disposeRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => disposeRef.current?.(), []);
  const highImpact = useMemo(() => HIGH_IMPACT.test(command), [command]);
  const running = Boolean(runId && !done);
  const card = { padding: 16, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel-subtle)', boxShadow: 'var(--shadow-soft)' };
  const button = { minHeight: 34, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-strong)', background: 'var(--panel)', font: '650 11px var(--font-ui)', cursor: 'pointer' };
  const complete = (event: TerminalDoneEvent): void => { setDone(event); setRunId(undefined); };
  const run = async (): Promise<void> => {
    if (!command.trim() || running) return;
    if (highImpact && !confirmed) { setError('此命令可能删除数据、请求管理员权限或对系统产生不可逆影响。请勾选最后确认。'); return; }
    setOutput([]); setDone(undefined); setError(undefined);
    try {
      const session = await startTerminalCommand(command, highImpact && confirmed, (event) => setOutput((current) => [...current, event].slice(-2_000)), complete);
      disposeRef.current = session.dispose; setRunId(session.runId);
    } catch (nextError) { setError(errorText(nextError)); }
  };
  const cancel = async (): Promise<void> => { if (!runId) return; try { await cancelTerminalCommand(runId); } catch (nextError) { setError(errorText(nextError)); } };
  return <section className="page-stack" aria-label="终端与编码"><div className="page-heading"><span>WORKSPACE / TERMINAL</span><h1>终端与编码</h1><p>命令只在你点击“运行”后以当前 Windows 用户权限执行。模型、网页和附件不会自动成为命令；输出、退出码与取消状态会保留在此窗口。</p></div>
    <section style={card}><strong style={{ color: 'var(--text-strong)' }}>本地命令</strong><textarea aria-label="本地终端命令" disabled={running} onChange={(event) => { setCommand(event.target.value); setConfirmed(false); }} placeholder="例如：npm test" style={{ width: '100%', minHeight: 90, marginTop: 10, padding: 11, resize: 'vertical', color: 'var(--text-strong)', border: '1px solid var(--border)', borderRadius: 10, outline: 'none', background: 'var(--canvas)', font: '12px/1.55 var(--font-mono)' }} value={command} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 9 }}>{EXAMPLES.map((example) => <button key={example} onClick={() => { setCommand(example); setConfirmed(false); }} style={button} type="button">{example}</button>)}</div>
      <p style={{ margin: '10px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.55 }}>工作目录：{workspace.outputTarget === 'selected-workspace' ? workspace.workspaceLabel ?? '已选择本地工作区' : '应用启动目录'}。可输入普通 Windows `cmd` 命令、PowerShell 已安装命令或项目工具命令。</p>
      {highImpact && <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 11, padding: 10, color: 'var(--text-strong)', border: '1px solid #ffb8b8', borderRadius: 10, background: '#fff4f4', fontSize: 11 }}><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" /><span>我确认要以当前用户权限运行这条可能产生删除、提权或外部副作用的命令。</span></label>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 14 }}><button disabled={!command.trim() || running} onClick={() => void run()} style={{ ...button, color: '#fff', borderColor: '#007aff', background: '#007aff', opacity: !command.trim() || running ? .5 : 1 }} type="button">{running ? '正在运行…' : '运行本地命令'}</button>{running && <button onClick={() => void cancel()} style={{ ...button, color: '#b42318', borderColor: '#f4b4af', background: '#fff' }} type="button">停止</button>}<small style={{ color: error ? '#b42318' : done?.cancelled ? '#b42318' : done ? 'var(--success)' : 'var(--muted)', fontSize: 10 }}>{error ?? (done ? (done.cancelled ? '命令已请求停止。' : `命令结束，退出码：${done.exitCode ?? '未知'}。`) : '尚未执行任何命令。')}</small></div>
    </section>
    <section style={card}><strong style={{ color: 'var(--text-strong)' }}>终端输出</strong><pre style={{ minHeight: 170, maxHeight: 350, margin: '10px 0 0', padding: 12, overflow: 'auto', color: 'var(--text-strong)', borderRadius: 10, background: '#101114', font: '12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{output.length ? output.map((event, index) => <span key={`${index}-${event.text}`}>{event.stream === 'stderr' ? '[stderr] ' : ''}{event.text}</span>) : '输出会在命令运行后显示在这里。'}</pre></section>
  </section>;
}
