import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { classifyWorkspaceFile, type WorkspaceFileDescriptor, type WorkspaceFilePreferencesV1 } from '../../runtime/workspace-file-contract';

type Imported = Readonly<{ file: File; descriptor: WorkspaceFileDescriptor }>;
const bytes = (value: number): string => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
const kind = (value: WorkspaceFileDescriptor): string => value.kind === 'text' ? '文本 / 代码' : value.kind === 'document' ? '文档 / 办公' : value.kind === 'archive' ? '压缩归档' : value.kind === 'media' ? '媒体' : '二进制';

/** 仅处理用户显式选择的 File 对象；不扫描磁盘、不上传、不自动加入 Agent 上下文。 */
export function WorkspaceFilesPage({ preferences, onChange }: { preferences: WorkspaceFilePreferencesV1; onChange(next: WorkspaceFilePreferencesV1): void }) {
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const [imports, setImports] = useState<readonly Imported[]>([]);
  const [preview, setPreview] = useState<string>();
  const [pickerError, setPickerError] = useState<string>();
  const update = (change: Partial<WorkspaceFilePreferencesV1>): void => onChange({ ...preferences, ...change, schemaVersion: 1 });
  const receive = (files: FileList | null): void => {
    if (!files) return;
    setPreview(undefined);
    setImports(Array.from(files).slice(0, 160).map((file, index) => ({ file, descriptor: classifyWorkspaceFile(file, index) })));
  };
  const read = async (item: Imported): Promise<void> => {
    if (item.descriptor.preview !== 'text') return;
    const content = await item.file.text();
    setPreview(content.slice(0, 18_000));
  };
  const chooseWorkspace = async (): Promise<void> => {
    setPickerError(undefined);
    const isTauri = typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
    if (!isTauri) { folderPicker.current?.click(); return; }
    try {
      const selected = await invoke<{ selected: boolean; label: string }>('choose_workspace_directory');
      if (selected.selected) update({ outputTarget: 'selected-workspace', workspaceLabel: selected.label });
    } catch { setPickerError('系统目录选择未完成；未保存路径、未扫描文件、未改变现有产物位置。'); }
  };
  const card = { padding: 16, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel-subtle)', boxShadow: 'var(--shadow-soft)' };
  const button = { minHeight: 34, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-strong)', background: 'var(--panel)', font: '650 11px var(--font-ui)', cursor: 'pointer' };
  const layout = { display: 'grid', gridTemplateColumns: 'minmax(0, 1.14fr) minmax(230px, .86fr)', gap: 12, alignItems: 'start' };
  return <section className="page-stack" aria-label="工作区与文件设置"><div className="page-heading"><span>WORKSPACE / FILES</span><h1>工作区与文件</h1><p>目录、文件和文件夹只有在你明确选择时才会进入受控导入清单；不会扫描整盘、上传内容或自动执行任何文件。</p></div>
    <div style={layout}>
    <section style={{ ...card, gridColumn: '1 / -1' }}><div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}><div><strong style={{ color: 'var(--text-strong)' }}>生成产物默认位置</strong><p style={{ margin: '5px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.5 }}>{preferences.outputTarget === 'app-managed' ? '应用管理目录：现有受控交付包与任务产物路径保持不变。' : `用户工作区：${preferences.workspaceLabel ?? '尚未选择目录'}`}</p></div><div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}><button aria-pressed={preferences.outputTarget === 'app-managed'} onClick={() => update({ outputTarget: 'app-managed' })} style={button} type="button">应用管理</button><button aria-pressed={preferences.outputTarget === 'selected-workspace'} onClick={() => void chooseWorkspace()} style={button} type="button">选择工作区文件夹</button></div></div>
      <small style={{ display: 'block', marginTop: 10, color: 'var(--muted)' }}>网页、Android 与 iPadOS 不显示系统绝对路径；Windows 原生目录选择会在后续受限执行器接入后用于明确导出，不会改变任务或 Provider 数据。</small></section>
    <section style={card}><div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}><div><strong style={{ color: 'var(--text-strong)' }}>导入文件或文件夹</strong><p style={{ margin: '5px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.5 }}>接受常见文本、代码、JSON、Markdown、PDF、Office、TeX、压缩包、媒体和二进制；归档与文档不会自动解压、执行或上传。</p></div><div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}><button onClick={() => filePicker.current?.click()} style={button} type="button">选择文件</button><button onClick={() => void chooseWorkspace()} style={button} type="button">选择文件夹</button></div></div>
      <input aria-label="选择要导入的文件" hidden multiple onChange={(event) => receive(event.currentTarget.files)} ref={filePicker} type="file" />
      {pickerError && <p role="alert" style={{ margin: '10px 0 0', color: 'var(--danger)', fontSize: 11 }}>{pickerError}</p>}
      <input aria-label="选择要导入的文件夹" hidden multiple onChange={(event) => { receive(event.currentTarget.files); update({ outputTarget: 'selected-workspace', workspaceLabel: event.currentTarget.files?.length ? `已选择 ${event.currentTarget.files.length} 项` : preferences.workspaceLabel }); }} ref={(element) => { folderPicker.current = element; if (element) element.setAttribute('webkitdirectory', ''); }} type="file" />
      {imports.length === 0 ? <p style={{ margin: '13px 0 0', color: 'var(--muted)', fontSize: 11 }}>尚未选择文件。支持的“可安全预览”会在选择后显示为只读限长文本；其他格式只显示元数据。</p> : <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, .92fr) minmax(0, 1.48fr)', gap: 12, marginTop: 13 }}><div style={{ display: 'grid', gap: 6, maxHeight: 280, overflow: 'auto' }}>{imports.map((item) => <button key={item.descriptor.id} onClick={() => void read(item)} style={{ ...button, display: 'grid', minHeight: 44, padding: '7px 9px', textAlign: 'left' }} title={item.descriptor.preview === 'text' ? '查看受限文本预览。' : '此格式只显示元数据，不会自动解析或执行。'} type="button"><strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.descriptor.name}</strong><small style={{ color: 'var(--muted)' }}>{kind(item.descriptor)} · {item.descriptor.extension || '无扩展名'} · {bytes(item.descriptor.byteSize)} · {item.descriptor.preview === 'text' ? '可预览' : '仅元数据'}</small></button>)}</div><pre style={{ minHeight: 168, maxHeight: 280, margin: 0, padding: 12, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 12, color: 'var(--text-strong)', background: 'var(--canvas)', font: '11px/1.55 var(--font-mono)' }}>{preview ?? '选择文本或代码文件以显示不超过 18,000 个字符的只读预览。PDF、DOCX、XLSX、PPTX、ZIP、7Z、RAR 与未知二进制当前只安全登记元数据。'}</pre></div>}</section>
    <section style={card}><strong style={{ color: 'var(--text-strong)' }}>格式与执行边界</strong><p style={{ margin: '7px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.6 }}>可登记不等于可执行。`exe`、`msi`、`dll`、`bat`、`cmd`、`ps1`、脚本和压缩包都仅作为静态导入对象；宏、嵌入对象、归档内容和文件内命令不会被自动运行。终端编码任务必须在独立“终端与编码”页面创建并进入审批。</p></section>
    </div>
  </section>;
}
