import { useMemo } from 'react';
import type { WorkspaceWriteApprovalRequest } from '../../runtime/workspace-tools';
import { countDiffLines, diffLines, MAX_DIFF_LINES, type DiffKind } from '../../runtime/text-diff';

/**
 * 写入确认：Agent 想改一个文件时，把前后差异和**真实操作类型**摆给用户看，再决定放不放行。
 *
 * 这里不给「总是允许」选项。每一次写入都是独立的事实，批量授权会让这道门形同虚设。
 * 审计整改 03：patch 工具已支持新建 / 删除 / 重命名，文案必须随操作类型变化——
 * 用户看到的说明必须等于实际授权的操作，绝不允许「提示只覆写、实际在删除」。
 */

const LINE_COLOR: Record<DiffKind, string> = {
  same: 'var(--muted-strong)',
  removed: 'var(--danger)',
  added: 'var(--accent-strong)',
};
const LINE_BACKGROUND: Record<DiffKind, string> = {
  same: 'transparent',
  removed: 'var(--danger-soft)',
  added: 'color-mix(in srgb, var(--accent-soft) 70%, transparent)',
};

const KIND_LABEL: Record<NonNullable<WorkspaceWriteApprovalRequest['kind']>, string> = {
  add: '新建文件',
  delete: '删除文件',
  move: '重命名并修改',
  update: '覆写文件',
};

function descriptionFor(request: WorkspaceWriteApprovalRequest): string {
  switch (request.kind) {
    case 'add':
      return '模型请求创建一个新文件。以下差异（左侧为空）是它将写入的全部内容。';
    case 'delete':
      return '模型请求删除这个文件。整份内容将被移除，本应用不做回收站备份；请确认不再需要它。';
    case 'move':
      return `模型请求把 ${request.path} 重命名并修改为 ${request.movePath ?? ''}。原路径的文件将被移除，内容写入新路径。`;
    default:
      return '模型请求覆写这个已存在的文件。以下差异是这次写入的全部影响。';
  }
}

export function WorkspaceWriteApproval({ request, onResolve }: { request: WorkspaceWriteApprovalRequest; onResolve(approved: boolean): void }) {
  const diff = useMemo(() => diffLines(request.previous.split('\n'), request.next.split('\n')), [request.previous, request.next]);
  const { removed, added } = useMemo(() => countDiffLines(diff), [diff]);
  const tooLarge = request.previous.split('\n').length > MAX_DIFF_LINES || request.next.split('\n').length > MAX_DIFF_LINES;
  const kind = request.kind ?? 'update';
  const kindLabel = KIND_LABEL[kind];
  const displayPath = request.kind === 'move' ? `${request.path} → ${request.movePath ?? ''}` : request.path;
  const approveLabel = kind === 'add' ? '允许新建' : kind === 'delete' ? '允许删除' : kind === 'move' ? '允许重命名' : '允许覆写';
  const panel = { padding: 16, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', boxShadow: 'var(--shadow-float)' };
  const button = { minHeight: 34, padding: '0 14px', border: '1px solid var(--border)', borderRadius: 10, font: '650 12px var(--font-ui)', cursor: 'pointer' };
  return <div role="dialog" aria-modal="true" aria-label={`确认${kindLabel}`} style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'grid', placeItems: 'center', padding: 20, background: 'color-mix(in srgb, var(--canvas) 55%, transparent)' }}>
    <div style={{ ...panel, display: 'grid', gap: 12, width: 'min(860px, 100%)', maxHeight: 'min(80dvh, 720px)', gridTemplateRows: 'auto auto minmax(0, 1fr) auto' }}>
      <div>
        <span style={{ color: 'var(--muted)', font: '760 10px var(--font-ui)', letterSpacing: '.08em' }}>WORKSPACE {kind.toUpperCase()} · 需要你确认</span>
        <h2 style={{ margin: '6px 0 0', color: 'var(--text-strong)', font: '650 17px/1.2 var(--font-ui)', wordBreak: 'break-all' }}>{displayPath}</h2>
        <p style={{ margin: '6px 0 0', color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.55 }}>{descriptionFor(request)}</p>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', color: 'var(--muted-strong)', fontSize: 11 }}>
        <span style={{ color: LINE_COLOR.removed, fontWeight: 700 }}>-{removed} 行</span>
        <span style={{ color: LINE_COLOR.added, fontWeight: 700 }}>+{added} 行</span>
        {tooLarge && <span>文件超过 {MAX_DIFF_LINES} 行，已改为先列全部原文、再列全部新内容。</span>}
      </div>
      <div style={{ minHeight: 0, overflow: 'auto', padding: 10, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)', font: '11px/1.6 var(--font-mono)' }}>
        {diff.map((line, index) => <div key={index} style={{ display: 'flex', gap: 8, color: LINE_COLOR[line.kind], background: LINE_BACKGROUND[line.kind], whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}><span style={{ flex: '0 0 auto', opacity: .7, userSelect: 'none' }}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span><span>{line.text || ' '}</span></div>)}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={() => onResolve(false)} style={{ ...button, color: 'var(--text-strong)', background: 'var(--panel)' }} type="button">拒绝，不改这个文件</button>
        <button onClick={() => onResolve(true)} style={{ ...button, color: '#fff', borderColor: 'var(--accent-strong)', background: 'var(--accent-strong)' }} type="button">{approveLabel}</button>
      </div>
    </div>
  </div>;
}
