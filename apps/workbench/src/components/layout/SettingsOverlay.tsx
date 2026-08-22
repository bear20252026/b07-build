import type { ReactNode } from 'react';
import type { WorkbenchPage } from './workbench-page';

type SettingsItem = { page: WorkbenchPage; icon: string; label: string; description: string };

const NAVIGATION: readonly { group: string; items: readonly SettingsItem[] }[] = [
  { group: 'AI CORE', items: [
    { page: 'models', icon: '◇', label: '模型连接', description: '第三方 API 的简洁连接向导' },
    { page: 'connections', icon: '✓', label: '已连接模型', description: '状态、测试与受限文本调用' },
  ] },
  { group: 'WORKSPACE', items: [
    { page: 'workspace-files', icon: '▧', label: '工作区与文件', description: '默认目录、受控导入与文件预览' },
    { page: 'terminal-coding', icon: '›_', label: '终端与编码', description: '审批式命令计划与编码工作区' },
    { page: 'operations', icon: '◷', label: '运行记录', description: '检查点、使用审计与只读轨迹' },
    { page: 'capabilities', icon: '◇', label: '扩展与能力', description: '扩展、知识、本地模型和浏览会话控制' },
  ] },
  { group: 'SYSTEM', items: [
    { page: 'security', icon: '⚙', label: '安全与系统', description: '只读审计、构件锁定和 Windows 发布证据' },
  ] },
];

function navigationPage(activePage: WorkbenchPage): WorkbenchPage {
  if (activePage === 'api-usage') return 'operations';
  if (activePage === 'agency-roles' || activePage === 'browser-sessions' || activePage === 'companion' || activePage === 'companion-service-sources' || activePage === 'companion-body-modules' || activePage === 'companion-character-models' || activePage === 'companion-character-cards' || activePage === 'companion-system') return 'capabilities';
  return activePage;
}

/**
 * 低频控制面以独立设置浮层呈现：聊天工作区不被替换，浮层内的导航不携带授权或执行能力。
 */
export function SettingsOverlay({ activePage, children, onClose, onNavigate, title }: {
  activePage: WorkbenchPage;
  children: ReactNode;
  onClose(): void;
  onNavigate(page: WorkbenchPage): void;
  title: string;
}) {
  const visiblePage = navigationPage(activePage);
  return <div aria-label="设置浮层遮罩" className="settings-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
    <section aria-describedby="settings-overlay-description" aria-label="AI Work OS 设置" aria-modal="true" className="settings-overlay" onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <aside className="settings-overlay-sidebar">
        <div className="settings-overlay-brand"><span aria-hidden="true">AW</span><div><strong>AI Work OS</strong><small>Settings</small></div></div>
        <button className="settings-overlay-back" onClick={onClose} title="关闭设置浮层并返回极简聊天工作区；当前任务与本机 Gateway 不会被中断。" type="button"><span aria-hidden="true">←</span> 返回聊天</button>
        <nav aria-label="设置分类" className="settings-overlay-nav">
          {NAVIGATION.map((section) => <section className="settings-overlay-nav-group" key={section.group}><span>{section.group}</span>{section.items.map((item) => <button aria-current={visiblePage === item.page ? 'page' : undefined} className={visiblePage === item.page ? 'active' : ''} key={item.page} onClick={() => onNavigate(item.page)} title={item.description} type="button"><i aria-hidden="true">{item.icon}</i><b>{item.label}</b></button>)}</section>)}
        </nav>
        <div className="settings-overlay-sidebar-note"><strong>本机控制面</strong><span>设置不会中断当前任务。需要写入或状态变更的能力仍要求你在页面内明确点击。</span></div>
      </aside>
      <div className="settings-overlay-main">
        <header className="settings-overlay-titlebar"><div><span>AI WORK OS / SETTINGS</span><h1>{title}</h1><p id="settings-overlay-description">低频设置集中于此；聊天首页仅保留任务发起、项目入口、工作方式与建议模板。</p></div><button aria-label="关闭设置并返回聊天" className="settings-overlay-close" onClick={onClose} title="关闭设置浮层并返回聊天工作区。" type="button">×</button></header>
        <div className="settings-overlay-content">{children}</div>
      </div>
    </section>
  </div>;
}
