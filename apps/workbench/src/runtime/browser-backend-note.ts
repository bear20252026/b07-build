// 浏览器后端开关的用户提示。
//
// 单独放在这里而不是写在组件里，是因为本仓**没有 DOM 测试环境**（无 jsdom /
// testing-library，也没有 .tsx 测试）。组件本身只能靠类型检查与构建兜底，
// 但"开关之后该说什么"是纯逻辑，抽出来就有牙齿了。

/**
 * 开关浏览器后端之后给用户看的提示。
 *
 * 关闭时必须报出**被断开的会话数**：那个数字是这次操作的实际影响，
 * 不说不等于没发生。
 */
export function backendToggleNote(wasEnabled: boolean, disconnected: number): string {
  if (!wasEnabled) return '已启用后端；Agent 现在可以调用浏览器工具。';
  return disconnected > 0 ? `已关闭后端，断开 ${disconnected} 个会话。` : '已关闭后端。';
}

/** 后端状态读不到时的说明。 */
export const BROWSER_BACKEND_UNAVAILABLE_TEXT =
  '读不到后端状态（可能不是桌面运行时，或原生命令缺失）。已按不可用处理，不会假装可用。';
