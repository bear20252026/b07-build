// 一个文件=一种作用：未实现能力的谓词（恒 false，单一事实源）。
//
// b07 已在多处声明这些能力不可用：agent-runtime 的浏览器会话快照
// （`browser-session-control.ts`）与 workbench 的会话投影
// （`browser-session-client.ts`）。此前它们各自以字面量 `false` 表达，
// 「不可用」没有唯一出口。本文件把它收敛为唯一事实源：谓词**恒返回 false**，
// 调用方（运行时快照、界面契约）引用同一组谓词即可。
//
// 为什么不是「留空」或「半成品」：缺席会让调用方无从照着写代码，半成品
// 又可能被误当成可用能力。占位包给出的是**契约完整、行为全拒**的第三种形态。

/** 未实现能力的字面量类型：与全部谓词的返回值一致，供类型声明引用。 */
export type UnavailableFlag = false;

/** 是否可执行浏览器动作（点击 / 输入 / 导航）。未实现，恒 false。 */
export function canExecuteBrowserActions(): false {
  return false;
}

/** 是否可读取页面内容（DOM / 文本 / 截图）。未实现，恒 false。 */
export function canReadPageContent(): false {
  return false;
}

/** 是否可读取浏览器秘密（cookie / profile / 凭据）。未实现，恒 false。 */
export function canReadBrowserSecrets(): false {
  return false;
}

/** 是否可控制桌面（鼠标 / 键盘 / 窗口）。未实现，恒 false。 */
export function canControlDesktop(): false {
  return false;
}

/** 是否可捕获屏幕。未实现，恒 false。 */
export function canCaptureScreen(): false {
  return false;
}

/** 浏览器 MCP 工具面（会话生命周期 / 只读观测 / 导航与交互）是否可用。未实现，恒 false。 */
export function canUseBrowserToolSurface(): false {
  return false;
}

/** 浏览器会话快照所需的四个不可用位（一次取齐，避免调用方逐个 import）。 */
export interface UnavailableCapabilityFlags {
  readonly canExecute: false;
  readonly canReadPageContent: false;
  readonly canReadBrowserSecrets: false;
  readonly canControlDesktop: false;
}

/**
 * 一次性取全部未实现能力位。返回**新建对象**，调用方无法通过修改返回值
 * 影响其它调用方（不可用性不可被就地篡改）。
 */
export function unavailableCapabilityFlags(): UnavailableCapabilityFlags {
  return {
    canExecute: canExecuteBrowserActions(),
    canReadPageContent: canReadPageContent(),
    canReadBrowserSecrets: canReadBrowserSecrets(),
    canControlDesktop: canControlDesktop(),
  };
}
