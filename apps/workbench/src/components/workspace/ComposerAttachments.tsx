import { useRef, useState, type DragEvent } from 'react';
import { classifyWorkspaceFile, type WorkspaceFileDescriptor } from '../../runtime/workspace-file-contract';

export const MAX_CHAT_TASK_ATTACHMENTS = 8;

export interface ComposerFileAttachment {
  readonly descriptor: WorkspaceFileDescriptor;
  /** 仅保留在 renderer 内存，直到用户明确发送任务或移除；绝不写入 localStorage。 */
  readonly file: File;
}

export interface ComposerAttachmentsProps {
  readonly attachments: readonly WorkspaceFileDescriptor[];
  onAdd(files: FileList | null): void;
  onRemove(id: string): void;
}

/**
 * High-frequency chat attachment affordance. It classifies only user-selected File
 * metadata. It never reads file contents, uploads, unpacks, executes, or sends
 * the attachment to any model by itself. 字节仅在用户点击发送任务时上传到本机 Gateway。
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
    <button className="composer-attach-button" onClick={() => picker.current?.click()} title="选择文件加入待处理附件清单；点击发送任务前不会上传、解压、执行或发送给模型。" type="button"><span aria-hidden="true">＋</span> 添加文件</button>
    <span className="composer-attachment-hint">也可拖放文件；发送时写入本机任务输入区，不会自动发给第三方模型。</span>
    {attachments.length > 0 && <div aria-label={`待处理附件 ${attachments.length} 个`} className="composer-attachment-list" role="list">{attachments.map((item) => <span className="composer-attachment-chip" key={item.id} role="listitem"><span title={`${item.kind} · ${item.byteSize} bytes`}>{item.name}</span><button aria-label={`移除附件 ${item.name}`} onClick={() => onRemove(item.id)} title="从本次待处理清单移除；不会删除本机文件。" type="button">×</button></span>)}</div>}
    {dragActive && <div aria-live="polite" className="composer-drop-hint">松开以登记待处理附件</div>}
  </div>;
}

export function descriptorsFromFiles(files: FileList | null, currentCount: number): readonly WorkspaceFileDescriptor[] {
  if (!files) return [];
  return Array.from(files).slice(0, Math.max(0, MAX_CHAT_TASK_ATTACHMENTS - currentCount)).map((file, index) => classifyWorkspaceFile(file, currentCount + index));
}

/** Merge only redacted descriptors; raw File objects never leave the chooser/drop event. */
export function mergeComposerAttachments(current: readonly WorkspaceFileDescriptor[], files: FileList | null): readonly WorkspaceFileDescriptor[] {
  const known = new Set(current.map((item) => `${item.name}\u0000${item.byteSize}`));
  return [...current, ...descriptorsFromFiles(files, current.length).filter((item) => !known.has(`${item.name}\u0000${item.byteSize}`))].slice(0, MAX_CHAT_TASK_ATTACHMENTS);
}

/** 从用户选择/拖放事件保留临时 File；不持久化、不读取内容，直到任务提交的显式副作用。 */
export function mergeComposerFileAttachments(current: readonly ComposerFileAttachment[], files: FileList | null): readonly ComposerFileAttachment[] {
  if (!files) return current;
  const known = new Set(current.map((item) => `${item.descriptor.name}\u0000${item.descriptor.byteSize}`));
  const additions: ComposerFileAttachment[] = [];
  for (const file of Array.from(files)) {
    if (current.length + additions.length >= MAX_CHAT_TASK_ATTACHMENTS || known.has(`${file.name}\u0000${file.size}`)) continue;
    const descriptor = classifyWorkspaceFile(file, current.length + additions.length);
    additions.push({ descriptor, file });
    known.add(`${file.name}\u0000${file.size}`);
  }
  return [...current, ...additions];
}
