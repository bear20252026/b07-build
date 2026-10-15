// 一个文件=一种作用：占位包的机器可检标记与不可用文案。
//
// 照 ZCode `@zcode/zcode-cua` 的 `zcodeCuaPlaceholder: true` 做法：占位身份
// 必须能被脚本/测试在不读注释、不读语义的情况下检出来。因此标记有两处，
// 且必须一致：
//   1. `package.json` 的 `awoCapabilityPlaceholder: true`（构建/CI 可检）；
//   2. 本文件导出的运行期常量 `CAPABILITY_PLACEHOLDER`（代码可检）。
//
// 「本包仍是占位」是一条可断言的不变式：任何真正落地某项能力的批次，
// 都必须显式把标记改为 false 并删除对应谓词/运行时的拒答路径——绝不允许
// 半成品悄悄让谓词变 true。

/** package.json 中的占位标记字段名（机器可检）。 */
export const CAPABILITY_PLACEHOLDER_FIELD = 'awoCapabilityPlaceholder' as const;

/** 运行期占位标记：恒为 true。测试据此断言「本包确实还是占位」。 */
export const CAPABILITY_PLACEHOLDER = true as const;

/** 本占位包覆盖的运行时面清单（未实现能力面的枚举，供测试逐项断言）。 */
export const PLACEHOLDER_SURFACES = [
  'computer-use-runtime',
  'desktop-control',
  'screen-capture',
  'browser-session-execution',
  'browser-tool-surface',
] as const;

export type PlaceholderSurface = (typeof PLACEHOLDER_SURFACES)[number];

/** 所有 fail-closed 结果共用的不可用说明（人类可读，含「未实现」事实）。 */
export const CAPABILITY_UNAVAILABLE_TEXT =
  'AI Work OS 本构建不含桌面控制 / 计算机使用能力：该能力面未实现，一律报告 unavailable 并失败关闭。';

/** 浏览器工具面「后端不可用」的稳定错误码（外部据此归因，不依赖文案）。 */
export const BROWSER_TOOL_UNAVAILABLE_CODE = 'browser_tool_backend_unavailable' as const;

/** 浏览器工具面不可用说明（人类可读；含「未实现后端」事实，供拒答文案复用）。 */
export const BROWSER_TOOL_UNAVAILABLE_TEXT =
  'AI Work OS 本构建不含浏览器自动化后端：浏览器 MCP 工具面（会话生命周期 / 只读观测 / 导航与交互）已声明但一律报告 unavailable 并失败关闭。';
