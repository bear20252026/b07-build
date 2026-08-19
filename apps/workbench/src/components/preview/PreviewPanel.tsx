// 一个文件=一种作用：宿主级持久产物预览（AionUi PreviewPanel/PreviewTabs 的独立实现）。
import { useState } from 'react';

type ViewKey = 'markdown' | 'html' | 'diff';

const TABS: { key: ViewKey; label: string }[] = [
  { key: 'markdown', label: '交付说明' },
  { key: 'html', label: '预览' },
  { key: 'diff', label: '变更' },
];

const COPY: Record<ViewKey, { title: string; description: string }> = {
  markdown: {
    title: '任务产物将在这里持续更新',
    description: '运行时完成事件、产物引用和可编辑 Markdown 将通过 C6 事件流投递到此面板。',
  },
  html: {
    title: '安全的单视图预览容器',
    description: '后续 HTML、文档和浏览器视图会保持宿主级持久化，不因会话切换而丢失状态。',
  },
  diff: {
    title: '每一项变更都应可审查',
    description: '文件修改、审批决策与可回滚 diff 将与任务事件关联，成为可解释交付的一部分。',
  },
};

export function PreviewPanel() {
  const [active, setActive] = useState<ViewKey>('markdown');
  const copy = COPY[active];

  return (
    <aside className="preview-panel" aria-label="产物预览">
      <header className="preview-header">
        <div>
          <div className="preview-title">交付预览</div>
          <div className="preview-subtitle">宿主级持久视图</div>
        </div>
        <span className="status-chip"><span className="status-dot" />同步</span>
      </header>
      <div className="preview-tabs" role="tablist" aria-label="预览类型">
        {TABS.map((tab) => (
          <button
            className={`preview-tab${active === tab.key ? ' active' : ''}`}
            key={tab.key}
            onClick={() => setActive(tab.key)}
            role="tab"
            aria-selected={active === tab.key}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <section className="preview-canvas">
        <div className="preview-artifact-type">{active} artifact</div>
        <h2>{copy.title}</h2>
        <p>{copy.description}</p>
        <div className="preview-lines" aria-hidden="true">
          <div className="preview-line" />
          <div className="preview-line short" />
          <div className="preview-line" />
          <div className="preview-line short" />
        </div>
      </section>
    </aside>
  );
}
