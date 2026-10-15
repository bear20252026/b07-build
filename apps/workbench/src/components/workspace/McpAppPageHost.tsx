// 一个文件=一种作用：MCP App 页面宿主——在 McpAppHost 之上加页面管理器层。
//
// 分层（对齐上游 plugin-ui/CONTRACT.md 的分层纪律 domain → app → adapters → components）：
// - 纯逻辑层：PluginPageManager 裁决容量/离屏回收/准入串行；PluginPageRegistry 做逻辑共享键
//   与引用计数；McpAppPage 是页面的活跃/忙碌状态存储。三者都不碰 DOM。
// - 适配层（本组件）：把页面状态接到 React 生命周期与 IntersectionObserver 可见性上——
//   挂载获取租约、卸载释放租约、进出视口上报可见性、活跃时占用沙箱槽位、工具调用计入忙碌。
// - 渲染层：活跃时把页面交给 McpAppHost（沙箱 iframe），被回收时只留占位（不挂载 iframe）。
//
// 共享语义：相同 pageKey 的多个宿主共享同一页面实例（同一 iframe 状态）；引用计数归零
// 后页面进入离屏回收宽限期。任务级销毁（会话/任务删除）由 removeMcpAppPageTask 触发。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { McpAppHost, type McpAppHostProps } from './McpAppHost';
import { McpAppPage, mcpAppPages } from '../../runtime/zcode/mcp-app-page';
import type { PluginPageLease } from '../../runtime/zcode/plugin-page-registry';

export interface McpAppPageHostProps extends McpAppHostProps {
  /** 逻辑共享键：包含 workspace/session/plugin/server/resource 与逻辑视图，由调用方构造。 */
  readonly pageKey: string;
  /** 任务键：决定容量与淘汰域；同一任务下的页面共享 30/64 上限。 */
  readonly taskKey: string;
}

export function McpAppPageHost({
  pageKey,
  taskKey,
  admission,
  html,
  onToolCallRequest,
  hostDescriptor,
  onGateViolation,
}: McpAppPageHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 本地页面对象：仅当本组件是首个使用方时被注册表采纳；否则改用共享实例。
  const localPageRef = useRef<McpAppPage | null>(null);
  if (localPageRef.current === null) localPageRef.current = new McpAppPage(pageKey, taskKey);
  const localPage = localPageRef.current;

  const [sharedPage, setSharedPage] = useState<McpAppPage | null>(null);
  const page = sharedPage ?? localPage;
  const effectiveRef = useRef<McpAppPage>(page);
  effectiveRef.current = page;
  const active = useSyncExternalStore(page.subscribe, page.getSnapshot);

  // 租约：挂载获取（同一逻辑键共享实例），卸载释放（引用归零后进入离屏回收）。
  useEffect(() => {
    let cancelled = false;
    let lease: PluginPageLease<McpAppPage> | undefined;
    void mcpAppPages
      .acquire(pageKey, taskKey, () => localPage)
      .then((acquired) => {
        if (cancelled) {
          acquired.release();
          return;
        }
        lease = acquired;
        setSharedPage(acquired.page);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      lease?.release();
    };
  }, [pageKey, taskKey, localPage]);

  // 可见性：锚点进出视口时上报；重新可见即取消回收计时并复活页面。
  useEffect(() => {
    const node = containerRef.current;
    if (node === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        mcpAppPages.setVisibility(pageKey, entry.isIntersecting);
        if (entry.isIntersecting) effectiveRef.current.activate();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [pageKey]);

  // 沙箱槽位（活页面上限 64）：活跃时占用，被回收后释放。sharedPage 变化后需重试。
  useEffect(() => {
    if (active) void mcpAppPages.reserve(pageKey).catch(() => undefined);
    else mcpAppPages.released(pageKey);
  }, [active, pageKey, sharedPage]);

  // 工具调用计入忙碌（在途期间不回收）；全部结束后做空闲确认。
  const handleToolCall = useCallback(
    async (toolName: string, args: unknown): Promise<unknown> => {
      const current = effectiveRef.current;
      current.beginCall();
      try {
        if (onToolCallRequest === undefined) throw new Error('mcpapp-tool-executor-unavailable');
        return await onToolCallRequest(toolName, args);
      } finally {
        current.endCall();
        mcpAppPages.settled(pageKey);
      }
    },
    [onToolCallRequest, pageKey],
  );
  const wrappedToolCall = onToolCallRequest === undefined ? undefined : handleToolCall;

  return (
    <div ref={containerRef} data-mcp-app-page={pageKey} style={{ display: 'grid', gap: 8 }}>
      {active ? (
        <McpAppHost
          admission={admission}
          html={html}
          onToolCallRequest={wrappedToolCall}
          hostDescriptor={hostDescriptor}
          onGateViolation={onGateViolation}
        />
      ) : (
        <div
          style={{
            color: 'var(--muted)',
            fontSize: 12,
            padding: 12,
            border: '1px dashed var(--border)',
            borderRadius: 12,
          }}
        >
          页面已离屏回收；滚动回可见区域即恢复。
        </div>
      )}
    </div>
  );
}
