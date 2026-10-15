// 一个文件=一种作用：把工作台里的真实用户交互事件接到手势 token 的打标口。
//
// 上游在 Electron guest 侧监听真实输入事件（input-event 的 mouseDown / keyDown /
// rawKeyDown）后调 registry.markUserGesture。b07 的沙箱是浏览器 iframe（不透明源），
// 宿主观察不到 iframe 内部的指针/键盘事件；可用的真实手势信号是**宿主文档**上的
// 用户交互事件（pointerdown / keydown），语义等价于浏览器给顶层文档的 transient
// activation——只有真实用户操作才会触发，应用脚本无法凭空产生。
//
// 本模块只做「真实事件 → 打标」的绑定，不含任何授权判定；判定与一次性消费在
// 网关（mcp-app-tool-gateway）侧完成。

/** 打标用的真实用户交互事件类型（对齐上游 mouseDown / keyDown）。 */
export const MCP_APP_GESTURE_EVENT_TYPES = ['pointerdown', 'keydown'] as const;

/** 可绑定手势事件的目标：浏览器里是 window / document，测试里是事件目标替身。 */
export interface McpAppGestureEventTarget {
  addEventListener(type: string, listener: () => void, options?: { capture?: boolean }): void;
  removeEventListener(type: string, listener: () => void, options?: { capture?: boolean }): void;
}

/**
 * 在真实用户交互事件（捕获阶段）上打标；返回解绑函数，供组件卸载时清理。
 * 捕获阶段确保即使宿主子元素 stopPropagation，打标仍会触发。
 */
export function markMcpAppGestureOnUserInteraction(
  target: McpAppGestureEventTarget,
  mark: () => void,
): () => void {
  const listener = (): void => mark();
  for (const type of MCP_APP_GESTURE_EVENT_TYPES) {
    target.addEventListener(type, listener, { capture: true });
  }
  return () => {
    for (const type of MCP_APP_GESTURE_EVENT_TYPES) {
      target.removeEventListener(type, listener, { capture: true });
    }
  };
}
