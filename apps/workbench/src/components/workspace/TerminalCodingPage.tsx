import { useState } from 'react';
import type { WorkspaceFilePreferencesV1 } from '../../runtime/workspace-file-contract';

type Template = Readonly<{ id: 'npm-test' | 'npm-build' | 'cargo-check' | 'python-compile'; label: string; command: string; effect: string }>;
const TEMPLATES: readonly Template[] = [
  { id: 'npm-test', label: 'Node 测试', command: 'npm test', effect: '在当前工作区运行项目测试；不传入任意 Shell 参数。' },
  { id: 'npm-build', label: '前端构建', command: 'npm run build', effect: '生成项目构建产物；应在执行前审查输出目录。' },
  { id: 'cargo-check', label: 'Rust 检查', command: 'cargo check', effect: '编译检查 Rust 项目；不执行生成的二进制。' },
  { id: 'python-compile', label: 'Python 语法检查', command: 'python -m compileall', effect: '检查 Python 文件语法；不执行应用逻辑。' },
];

/** 终端只构造审查计划；实际执行必须由受控运行管道在用户批准后处理。 */
export function TerminalCodingPage({ workspace }: { workspace: WorkspaceFilePreferencesV1 }) {
  const [selected, setSelected] = useState<Template>(TEMPLATES[0]);
  const [prepared, setPrepared] = useState(false);
  const card = { padding: 16, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel-subtle)', boxShadow: 'var(--shadow-soft)' };
  const button = { minHeight: 34, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-strong)', background: 'var(--panel)', font: '650 11px var(--font-ui)', cursor: 'pointer' };
  return <section className="page-stack" aria-label="终端与编码设置"><div className="page-heading"><span>WORKSPACE / TERMINAL</span><h1>终端与编码</h1><p>这里创建可审查的编码命令计划。它不是自由 Shell，也不会从对话、网页、上传文件或模型输出接受可执行命令。</p></div>
    <section style={card}><strong style={{ color: 'var(--text-strong)' }}>选择受限命令模板</strong><div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 11 }}>{TEMPLATES.map((template) => <button aria-pressed={selected.id === template.id} key={template.id} onClick={() => { setSelected(template); setPrepared(false); }} style={button} title={template.effect} type="button">{template.label}</button>)}</div></section>
    <section style={card}><div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, .72fr)', gap: 14 }}><div><span style={{ color: 'var(--muted)', fontSize: 9, fontWeight: 800, letterSpacing: '.08em' }}>COMMAND PLAN · REVIEW REQUIRED</span><h2 style={{ margin: '5px 0 7px', color: 'var(--text-strong)', fontSize: 18 }}>{selected.label}</h2><code style={{ display: 'block', padding: '9px 10px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-strong)', background: 'var(--canvas)', font: '11px var(--font-mono)' }}>{selected.command}</code><p style={{ margin: '9px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.55 }}>{selected.effect}</p></div><div><strong style={{ color: 'var(--text-strong)', fontSize: 11 }}>工作目录</strong><p style={{ margin: '6px 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.5 }}>{workspace.outputTarget === 'selected-workspace' ? workspace.workspaceLabel ?? '已选择用户工作区（路径不回显）' : '应用管理的受控工作区'}</p><small style={{ color: 'var(--muted)', fontSize: 10 }}>环境变量、绝对路径和秘密不会写入命令计划或终端输出。</small></div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--border)' }}><button onClick={() => setPrepared(true)} style={{ ...button, color: '#fff', borderColor: 'var(--accent-strong)', background: 'var(--accent-strong)' }} type="button">创建待审批计划</button><small style={{ color: prepared ? 'var(--success)' : 'var(--muted)', fontSize: 10 }}>{prepared ? '计划已准备：请在受控执行流程中逐步批准；本页没有直接运行命令。' : '尚未运行任何系统命令。'}</small></div></section>
    <section style={card}><strong style={{ color: 'var(--text-strong)' }}>终端安全边界</strong><p style={{ margin: '7px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.6 }}>系统不会开放 `cmd /c`、PowerShell 任意字符串、用户指定可执行文件、管理员提权、环境继承或后台守护进程。未来执行器只可接受此页固定模板产生的计划，并且每一步都需要明确审阅、输出上限和可取消状态。</p></section>
  </section>;
}
