// apps/workbench/src/main.tsx —— 一个文件=一个作用：React 挂载入口（不写业务）
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');
createRoot(rootEl).render(<App />);
