// apps/workbench/src/App.tsx
// 一个文件=一个作用：三栏工作台布局（参照 AionUi Layout.tsx：Sider + Chat + Preview 宿主级持久）。
// 不写业务：只组装布局、持有事件订阅（C6），不直连 provider/DB。
import { useState } from 'react';
import type { TaskEvent } from '@awo/protocol';
import { Sider } from './components/layout/Sider';
import { MessageThinking } from './pages/conversation/Messages/MessageThinking';
import { PreviewPanel } from './components/preview/PreviewPanel';

export function App() {
  // 事件订阅：UI 只读事件流（C6），不修改 Agent 内部状态
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [thinking, setThinking] = useState<string | null>(null);

  const pushEvent = (e: TaskEvent): void => {
    setEvents((prev) => [...prev.slice(-199), e]);
    if (e.type === 'plan.proposed') setThinking('计划已生成：' + e.steps.length + ' 步');
    if (e.type === 'task.completed') setThinking('任务完成');
  };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui' }}>
      <Sider />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{ padding: '8px 16px', borderBottom: '1px solid #e5e7eb' }}>
          <strong>AI Work OS</strong> — 任务工作台（事件数: {events.length}）
        </header>
        <section style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {thinking && <MessageThinking content={thinking} />}
          {events.map((e, i) => (
            <div key={i} style={{ fontSize: 13, color: '#6b7280', padding: '2px 0' }}>
              {e.type} @ {new Date(e.at).toLocaleTimeString()}
            </div>
          ))}
        </section>
        <PreviewPanel />
        <footer style={{ padding: 8, borderTop: '1px solid #e5e7eb' }}>
          <button onClick={() => pushEvent({ type: 'plan.proposed', taskId: 'T1', steps: [{ id: 's1', description: '研究' }], at: Date.now() })}>
            发一条计划事件
          </button>
        </footer>
      </main>
    </div>
  );
}
