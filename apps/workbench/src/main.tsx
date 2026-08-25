// apps/workbench/src/main.tsx —— React 挂载入口
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LocaleProvider } from './i18n/LocaleProvider';
import './workbench.css';

type ErrorBoundaryState = { error?: Error };

class WorkbenchErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[NOVA] Workbench render failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main className="workbench-boot-error" role="alert">
          <section>
            <strong>NOVA</strong>
            <h1>工作台暂时无法渲染</h1>
            <p>请重启应用后重试；如果问题持续，请提供下方诊断信息。</p>
            <code>{this.state.error.message || '未知首屏错误'}</code>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');
createRoot(rootEl).render(<WorkbenchErrorBoundary><LocaleProvider><App /></LocaleProvider></WorkbenchErrorBoundary>);
