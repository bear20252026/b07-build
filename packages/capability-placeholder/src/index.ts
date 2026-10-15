// 一个文件=一种作用：占位包的唯一公开出口（聚合契约、谓词与标记）。
//
// 未实现的桌面控制 / 计算机使用能力以本包「契约包 + 全拒实现」占位：
// 调用方照着类型写代码，运行期得到明确的 fail-closed 结果，而不是一个
// 偶尔能跑通的半成品被误当成可用能力。

export {
  CAPABILITY_PLACEHOLDER,
  CAPABILITY_PLACEHOLDER_FIELD,
  CAPABILITY_UNAVAILABLE_TEXT,
  PLACEHOLDER_SURFACES,
  type PlaceholderSurface,
} from './placeholder-marker.js';

export {
  canCaptureScreen,
  canControlDesktop,
  canExecuteBrowserActions,
  canReadBrowserSecrets,
  canReadPageContent,
  unavailableCapabilityFlags,
  type UnavailableCapabilityFlags,
  type UnavailableFlag,
} from './capability-predicates.js';

export {
  createComputerUseRuntime,
  type ComputerUseExecuteInput,
  type ComputerUseRuntime,
  type ComputerUseRuntimeContext,
  type ComputerUseRuntimeOptions,
  type ComputerUseToolResult,
} from './computer-use-runtime.js';

export {
  DenyCapabilityPermissionPort,
  type CapabilityPermissionPort,
  type CapabilityPermissionQuestion,
} from './permission-port.js';
