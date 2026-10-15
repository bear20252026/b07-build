import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFilePreferencesV1 } from '../../runtime/workspace-file-contract';
import { cancelTerminalCommand, classifyTerminalCommand, startTerminalCommand, type TerminalCommandAssessment, type TerminalDoneEvent, type TerminalOutputEvent } from '../../runtime/terminal-client';

const EXAMPLES = ['npm test', 'npm run build', 'cargo check', 'git status'];
const CLASS_LABEL: Record<TerminalCommandAssessment['class'], string> = {
  'read-only': '只读',
  routine: '常规',
  'state-changing': '需确认',
  denied: '不允许',
};
const DENIAL_TEXT: Record<string, string> = {
  'terminal-command-denied': '这条命令包含会丢数据或改系统状态的片段，终端一律不执行。',
  'terminal-command-chaining-denied': '终端不接受命令拼接、管道与重定向：一条命令就是一条命令。',
  'terminal-command-not-allowed': '这个可执行文件不在终端白名单内。终端只用于构建、测试与查看。',
  'terminal-command-invalid': '命令无法解析为参数列表（例如引号未闭合）。请修正后重试。',
};

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (text.includes('terminal-command-confirmation-required')) return '该命令会改变仓库或对外发布状态。请勾选最后确认后再运行。';
  if (text.includes('terminal-command-spawn-failed')) return '命令进程启动失败。请检查本机环境。';
  if (text.includes('terminal-command-not-found')) return '命令没有在 PATH 里找到对应的可执行文件（终端现在直接启动白名单程序本身，不再经过命令解释器）。请确认工具已安装并在 PATH 中。';
  if (text.includes('terminal-workdir-escapes-workspace')) return '指定的工作目录不在当前工作区内，已被拒绝。';
  for (const [code, message] of Object.entries(DENIAL_TEXT)) if (text.includes(code)) return message;
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
  const [assessment, setAssessment] = useState<{ command: string; value: TerminalCommandAssessment }>();
  const disposeRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => disposeRef.current?.(), []);
  const trimmed = command.trim();
  const current = assessment?.command === trimmed ? assessment.value : undefined;
  // 判定来自宿主侧策略：界面不再各自维护一份「哪条命令危险」的正则。
  useEffect(() => {
    if (!trimmed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void classifyTerminalCommand(trimmed)
        .then((value) => { if (!cancelled) setAssessment({ command: trimmed, value }); })
        .catch(() => { if (!cancelled) setAssessment(undefined); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [trimmed]);
  const highImpact = current?.requiresConfirmation ?? false;
  const denied = current?.denial ?? undefined;
  const running = Boolean(runId && !done);
  const card = { padding: 16, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel-subtle)', boxShadow: 'var(--shadow-soft)' };
  const button = { minHeight: 34, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-strong)', background: 'var(--panel)', font: '650 11px var(--font-ui)', cursor: 'pointer' };
  const complete = (event: TerminalDoneEvent): void => { setDone(event); setRunId(undefined); };
  const run = async (): Promise<void> => {
    if (!trimmed || running) return;
    setError(undefined);
    let value = current;
    if (!value) {
      try { value = await classifyTerminalCommand(trimmed); setAssessment({ command: trimmed, value }); }
      catch (nextError) { setError(errorText(nextError)); return; }
    }
    if (value.denial) { setError(errorText(value.denial)); return; }
    if (value.requiresConfirmation && !confirmed) { setError('此命令会改变仓库或对外发布状态。请勾选最后确认。'); return; }
    setOutput([]); setDone(undefined);
    try {
      const session = await startTerminalCommand(trimmed, value.requiresConfirmation && confirmed, (event) => setOutput((current) => [...current, event].slice(-2_000)), complete);
      disposeRef.current = session.dispose; setRunId(session.runId);
    } catch (nextError) { setError(errorText(nextError)); }
  };
  const cancel = async (): Promise<void> => { if (!runId) return; try { await cancelTerminalCommand(runId); } catch (nextError) { setError(errorText(nextError)); } };
  const badge = useMemo(() => {
    if (!current) return undefined;
    const color = current.class === 'denied' ? '#b42318' : current.requiresConfirmation ? '#8a6100' : current.readOnly ? 'var(--success)' : 'var(--muted-strong)';
    return { color, text: CLASS_LABEL[current.class] };
  }, [current]);
  return <section className="page-stack" aria-label="终端与编码"><div className="page-heading"><span>WORKSPACE / TERMINAL</span><h1>终端与编码</h1><p>命令只在你点击“运行”后以当前 Windows 用户权限执行。模型、网页和附件不会自动成为命令；输出、退出码与取消状态会保留在此窗口。</p></div>
    <section style={card}><strong style={{ color: 'var(--text-strong)' }}>本地命令</strong><textarea aria-label="本地终端命令" disabled={running} onChange={(event) => { setCommand(event.target.value); setConfirmed(false); }} placeholder="例如：npm test" style={{ width: '100%', minHeight: 90, marginTop: 10, padding: 11, resize: 'vertical', color: 'var(--text-strong)', border: '1px solid var(--border)', borderRadius: 10, outline: 'none', background: 'var(--canvas)', font: '12px/1.55 var(--font-mono)' }} value={command} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 9, alignItems: 'center' }}>{EXAMPLES.map((example) => <button key={example} onClick={() => { setCommand(example); setConfirmed(false); }} style={button} type="button">{example}</button>)}{badge && <small aria-label="命令判定" style={{ color: badge.color, font: '650 10px var(--font-ui)' }}>{badge.text}</small>}</div>
      <p style={{ margin: '10px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.55 }}>工作目录：{workspace.outputTarget === 'selected-workspace' ? workspace.workspaceLabel ?? '已选择本地工作区' : '应用启动目录'}。可输入普通 Windows `cmd` 命令、PowerShell 已安装命令或项目工具命令。</p>
      {denied && <p style={{ margin: '10px 0 0', color: '#b42318', fontSize: 11, lineHeight: 1.55 }}>{DENIAL_TEXT[denied] ?? '该命令不被终端策略允许。'}</p>}
      {highImpact && <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 11, padding: 10, color: 'var(--text-strong)', border: '1px solid #ffb8b8', borderRadius: 10, background: '#fff4f4', fontSize: 11 }}><input checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" /><span>我确认要以当前用户权限运行这条会改变仓库或对外发布状态的命令。</span></label>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 14 }}><button disabled={!trimmed || running || Boolean(denied)} onClick={() => void run()} style={{ ...button, color: '#fff', borderColor: '#007aff', background: '#007aff', opacity: !trimmed || running || denied ? .5 : 1 }} type="button">{running ? '正在运行…' : '运行本地命令'}</button>{running && <button onClick={() => void cancel()} style={{ ...button, color: '#b42318', borderColor: '#f4b4af', background: '#fff' }} type="button">停止</button>}<small style={{ color: error ? '#b42318' : done?.cancelled ? '#b42318' : done ? 'var(--success)' : 'var(--muted)', fontSize: 10 }}>{error ?? (done ? (done.cancelled ? '命令已请求停止。' : `命令结束，退出码：${done.exitCode ?? '未知'}。`) : '尚未执行任何命令。')}</small></div>
    </section>
    <section style={card}><strong style={{ color: 'var(--text-strong)' }}>终端输出</strong><pre style={{ minHeight: 170, maxHeight: 350, margin: '10px 0 0', padding: 12, overflow: 'auto', color: 'var(--text-strong)', borderRadius: 10, background: '#101114', font: '12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{output.length ? output.map((event, index) => <span key={`${index}-${event.text}`}>{event.stream === 'stderr' ? '[stderr] ' : ''}{event.text}</span>) : '输出会在命令运行后显示在这里。'}</pre></section>
  </section>;
}
