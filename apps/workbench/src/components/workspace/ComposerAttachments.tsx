import { useRef, useState, type DragEvent } from 'react';
import { classifyWorkspaceFile, type WorkspaceFileDescriptor } from '../../runtime/workspace-file-contract';

export interface ComposerAttachmentsProps {
  readonly attachments: readonly WorkspaceFileDescriptor[];
  onAdd(files: FileList | null): void;
  onRemove(id: string): void;
}

/**
 * High-frequency chat attachment affordance. It classifies only user-selected File
 * metadata. It never reads file contents, uploads, unpacks, executes, or includes
 * the attachment in a model request by itself.
 */
export function ComposerAttachments({ attachments, onAdd, onRemove }: ComposerAttachmentsProps) {
  const picker = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const prevent = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const drop = (event: DragEvent<HTMLElement>): void => {
    prevent(event);
    setDragActive(false);
    onAdd(event.dataTransfer.files);
  };

  return <div className={`composer-attachments${dragActive ? ' is-drag-active' : ''}`} onDragEnter={(event) => { prevent(event); setDragActive(true); }} onDragLeave={(event) => { prevent(event); setDragActive(false); }} onDragOver={prevent} onDrop={drop}>
    <input aria-label="选择待处理附件" className="composer-attachment-picker" multiple onChange={(event) => { onAdd(event.target.files); event.currentTarget.value = ''; }} ref={picker} type="file" />
    <button className="composer-attach-button" onClick={() => picker.current?.click()} title="选择文件加入待处理附件清单；不会自动上传、解压、执行或发送给模型。" type="button"><span aria-hidden="true">＋</span> 添加文件</button>
    <span className="composer-attachment-hint">也可拖放文件到这里；仅登记名称、大小与类型。</span>
    {attachments.length > 0 && <div aria-label={`待处理附件 ${attachments.length} 个`} className="composer-attachment-list" role="list">{attachments.map((item) => <span className="composer-attachment-chip" key={item.id} role="listitem"><span title={`${item.kind} · ${item.byteSize} bytes`}>{item.name}</span><button aria-label={`移除附件 ${item.name}`} onClick={() => onRemove(item.id)} title="从本次待处理清单移除；不会删除本机文件。" type="button">×</button></span>)}</div>}
    {dragActive && <div aria-live="polite" className="composer-drop-hint">松开以登记待处理附件</div>}
  </div>;
}

export function descriptorsFromFiles(files: FileList | null, currentCount: number): readonly WorkspaceFileDescriptor[] {
  if (!files) return [];
  return Array.from(files).slice(0, Math.max(0, 24 - currentCount)).map((file, index) => classifyWorkspaceFile(file, currentCount + index));
}

/** Merge only redacted descriptors; raw File objects never leave the chooser/drop event. */
export function mergeComposerAttachments(current: readonly WorkspaceFileDescriptor[], files: FileList | null): readonly WorkspaceFileDescriptor[] {
  const known = new Set(current.map((item) => `${item.name}\u0000${item.byteSize}`));
  return [...current, ...descriptorsFromFiles(files, current.length).filter((item) => !known.has(`${item.name}\u0000${item.byteSize}`))].slice(0, 24);
}
