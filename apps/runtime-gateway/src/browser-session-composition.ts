import { BrowserSessionControlPlane, SqliteBrowserSessionStore } from '@awo/agent-runtime';

export interface BrowserSessionComposition {
  readonly browserSessions: BrowserSessionControlPlane;
  close(): void;
}

/** 浏览控制仅创建可审计、不可执行的本机会话账本；不启动浏览器、不读取 profile 或页面。 */
export function createBrowserSessionComposition(path: string): BrowserSessionComposition {
  const store = new SqliteBrowserSessionStore(path);
  return { browserSessions: new BrowserSessionControlPlane(store), close: () => store.close() };
}
