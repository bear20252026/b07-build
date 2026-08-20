import { useEffect, useState } from 'react';
import { useLocale } from '../../i18n/LocaleProvider';
import type {
  WorkbenchTaskDeliveryReceipt,
  WorkbenchTaskFile,
  WorkbenchTaskFileDiff,
  WorkbenchTaskFilePreview,
} from '../../runtime/task-client';
import { CitationPreview } from './CitationPreview';
import { HttpKnowledgeSearchClient, type CitationPreview as Citation } from '../../runtime/knowledge-client';

type ViewKey = 'files' | 'code' | 'diff' | 'delivery' | 'citations';

const knowledgeClient = new HttpKnowledgeSearchClient();
const TABS: readonly ViewKey[] = ['files', 'code', 'diff', 'delivery', 'citations'];

export interface PreviewPanelProps {
  gatewayAttached: boolean;
  taskId: string | undefined;
  runId: string | undefined;
  files: readonly WorkbenchTaskFile[];
  deliveries: readonly WorkbenchTaskDeliveryReceipt[];
  onFilePreview(taskFileId: string): Promise<WorkbenchTaskFilePreview>;
  onFileDiff(taskFileId: string): Promise<WorkbenchTaskFileDiff>;
  onCreateDelivery(): Promise<void>;
  deliveryDownloadUrl(deliveryId: string): string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function PreviewPanel({
  gatewayAttached,
  taskId,
  runId,
  files,
  deliveries,
  onFilePreview,
  onFileDiff,
  onCreateDelivery,
  deliveryDownloadUrl,
}: PreviewPanelProps) {
  const [active, setActive] = useState<ViewKey>('files');
  const [query, setQuery] = useState('');
  const [citations, setCitations] = useState<readonly Citation[]>([]);
  const [loadingCitations, setLoadingCitations] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [creatingDelivery, setCreatingDelivery] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string>();
  const [preview, setPreview] = useState<WorkbenchTaskFilePreview>();
  const [diff, setDiff] = useState<WorkbenchTaskFileDiff>();
  const [error, setError] = useState<string>();
  const { messages } = useLocale();
  const selectedFile = files.find((file) => file.taskFileId === selectedFileId);

  useEffect(() => {
    setSelectedFileId(files.at(-1)?.taskFileId);
    setPreview(undefined);
    setDiff(undefined);
    setError(undefined);
    setActive('files');
  }, [taskId, runId]);

  useEffect(() => {
    setSelectedFileId((current) => current && files.some((file) => file.taskFileId === current) ? current : files.at(-1)?.taskFileId);
  }, [files]);

  const loadFile = async (file: WorkbenchTaskFile, nextView: 'code' | 'diff' = 'code'): Promise<void> => {
    setSelectedFileId(file.taskFileId);
    setActive(nextView);
    setLoadingFile(true);
    setError(undefined);
    try {
      if (nextView === 'code') setPreview(await onFilePreview(file.taskFileId));
      else setDiff(await onFileDiff(file.taskFileId));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '任务文件读取失败');
    } finally {
      setLoadingFile(false);
    }
  };

  const searchKnowledge = async (): Promise<void> => {
    if (!query.trim() || loadingCitations) return;
    setLoadingCitations(true);
    setError(undefined);
    try {
      setCitations(await knowledgeClient.search(query));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : messages.preview.knowledgeError);
    } finally {
      setLoadingCitations(false);
    }
  };

  const createDelivery = async (): Promise<void> => {
    if (creatingDelivery || !taskId || !runId) return;
    setCreatingDelivery(true);
    setError(undefined);
    try {
      await onCreateDelivery();
      setActive('delivery');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '任务交付包创建失败');
    } finally {
      setCreatingDelivery(false);
    }
  };

  return (
    <aside className="preview-panel" aria-label={messages.preview.aria}>
      <header className="preview-header">
        <div>
          <div className="preview-title">{messages.preview.title}</div>
          <div className="preview-subtitle">{messages.preview.subtitle}</div>
        </div>
        <span className={`status-chip${gatewayAttached ? '' : ' muted'}`}><span className="status-dot" />{gatewayAttached ? `${files.length} files` : messages.common.local}</span>
      </header>
      <div className="preview-tabs" role="tablist" aria-label={messages.preview.tabsAria}>
        {TABS.map((tab) => (
          <button
            aria-selected={active === tab}
            className={`preview-tab${active === tab ? ' active' : ''}`}
            key={tab}
            onClick={() => setActive(tab)}
            role="tab"
            type="button"
          >
            {messages.preview.tabs[tab]}
          </button>
        ))}
      </div>
      {error && <div className="preview-error" role="alert">{error}</div>}
      {active === 'citations' ? (
        <CitationPreview
          citations={citations}
          error={error}
          loading={loadingCitations}
          onQueryChange={setQuery}
          onSearch={() => void searchKnowledge()}
          query={query}
        />
      ) : active === 'files' ? (
        <section className="preview-canvas task-files-canvas" aria-label={messages.preview.files.title}>
          <div className="preview-draft-heading"><div><div className="preview-artifact-type">TASK / RUN SCOPED</div><h2>{messages.preview.files.title}</h2></div><span className="task-file-count">{files.length}</span></div>
          {files.length === 0 ? <p className="preview-empty">{messages.preview.files.empty}</p> : <div className="task-file-list">
            {files.map((file) => <article className={`task-file-card${selectedFileId === file.taskFileId ? ' selected' : ''}`} key={file.taskFileId}>
              <button className="task-file-open" onClick={() => void loadFile(file)} type="button">
                <span className="task-file-icon">{file.mediaType === 'text/markdown' ? 'MD' : file.mediaType === 'application/json' ? '{}' : 'CODE'}</span>
                <span className="task-file-name"><strong>{file.logicalPath}</strong><small>v{file.version} · {formatBytes(file.byteSize)}</small></span>
              </button>
              <button aria-label={`查看 ${file.displayName} 的差异`} className="task-file-diff" onClick={() => void loadFile(file, 'diff')} type="button">Diff</button>
            </article>)}
          </div>}
        </section>
      ) : active === 'code' ? (
        <section className="preview-canvas code-preview-canvas" aria-label={messages.preview.code.title}>
          <div className="preview-draft-heading"><div><div className="preview-artifact-type">READ ONLY · {preview?.language ?? 'TEXT'}</div><h2>{selectedFile?.logicalPath ?? messages.preview.code.title}</h2></div>{selectedFile && <button className="draft-toggle" onClick={() => void loadFile(selectedFile, 'diff')} type="button">Diff</button>}</div>
          {loadingFile ? <p className="preview-empty">Loading controlled preview…</p> : preview ? <><pre className="task-code-preview"><code>{preview.content}</code></pre>{preview.truncated && <p className="preview-boundary">{messages.preview.code.truncated}</p>}</> : <p className="preview-empty">{messages.preview.code.empty}</p>}
        </section>
      ) : active === 'diff' ? (
        <section className="preview-canvas code-preview-canvas" aria-label={messages.preview.diff.title}>
          <div className="preview-draft-heading"><div><div className="preview-artifact-type">REVIEWABLE CHANGE</div><h2>{selectedFile?.logicalPath ?? messages.preview.diff.title}</h2></div>{selectedFile && <button className="draft-toggle" onClick={() => void loadFile(selectedFile)} type="button">Code</button>}</div>
          {loadingFile ? <p className="preview-empty">Loading bounded diff…</p> : diff ? <><pre className="task-code-preview task-code-preview--diff"><code>{diff.content}</code></pre>{diff.truncated && <p className="preview-boundary">{messages.preview.diff.truncated}</p>}{diff.previousVersion === undefined && <p className="preview-boundary">{messages.preview.diff.empty}</p>}</> : <p className="preview-empty">{messages.preview.diff.empty}</p>}
        </section>
      ) : (
        <section className="preview-canvas delivery-canvas" aria-label={messages.preview.delivery.title}>
          <div className="preview-draft-heading"><div><div className="preview-artifact-type">USER-INITIATED ZIP</div><h2>{messages.preview.delivery.title}</h2></div><button className="delivery-create" disabled={!gatewayAttached || files.length === 0 || creatingDelivery} onClick={() => void createDelivery()} type="button">{creatingDelivery ? messages.preview.delivery.creating : messages.preview.delivery.create}</button></div>
          <p className="delivery-description">{messages.preview.delivery.description}</p>
          {deliveries.length === 0 ? <p className="preview-empty">{messages.preview.delivery.empty}</p> : <div className="delivery-list">{deliveries.map((receipt) => <article className="delivery-card" key={receipt.deliveryId}><div><strong>AI Work OS delivery</strong><span>{messages.preview.delivery.receipt(receipt.fileCount, receipt.byteSize)} · SHA-256 {receipt.sha256.slice(0, 12)}…</span></div><a className="delivery-download" download href={deliveryDownloadUrl(receipt.deliveryId)}>{messages.preview.delivery.download}</a></article>)}</div>}
        </section>
      )}
    </aside>
  );
}
