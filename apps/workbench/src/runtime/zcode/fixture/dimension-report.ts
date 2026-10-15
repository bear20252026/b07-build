// 一个文件=一种作用：MCP Apps 分维夹具的结果模型与执行器。
//
// 为什么单独抽这一层：上游 ZCode 的 `mcp-apps-host-fixture` 把 retention / storage /
// sampling 三个维度**分别驱动**（各自 main + 各自 results.json）。b07 是 Tauri + WebView2，
// 没有 Electron 驱动（真实 BrowserWindow + webview + preload + executeJavaScript）可用，
// 但「分维」这一核心价值必须保留：每个维度是独立可运行、独立报告的单元。
//
// 本文件只放两件事：维度的形状（一条检查 = 一个具名断言）与逐项执行器。
// 不依赖 DOM、不依赖 Node（工作台 src 层禁止 `node:` 导入），因此同一份维度定义
// 既能被 node:test 逐项报告（CI），也能被真实 WebView2 里的夹具页面整段渲染（人工验收）。

/** 三个维度：与上游 retention / storage / sampling 一一对应。 */
export type McpAppFixtureDimensionId = 'retention' | 'storage' | 'sampling';

/** 一条不变式检查：name 是给人看的一句话，run 抛出即失败。 */
export interface McpAppFixtureCheck {
  readonly name: string;
  run(): void | Promise<void>;
}

/** 一个维度的定义：可分别运行、分别报告。 */
export interface McpAppFixtureDimension {
  readonly id: McpAppFixtureDimensionId;
  readonly title: string;
  readonly checks: readonly McpAppFixtureCheck[];
}

/** 单条检查的结果。detail 只在失败时携带原因。 */
export interface McpAppFixtureCheckOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** 一个维度的运行报告：ok = 全部检查通过。 */
export interface McpAppFixtureDimensionReport {
  readonly id: McpAppFixtureDimensionId;
  readonly title: string;
  readonly checks: readonly McpAppFixtureCheckOutcome[];
  readonly ok: boolean;
}

/**
 * 断言工具：不用 node:assert（工作台 src 层不得导入 node:），用最朴素的抛错表达。
 * 消息里带上实际值，夹具页面与 CI 都能直接读出「期望 vs 实际」。
 */
export function expect(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/** 相等断言：消息里带上期望/实际，便于人工验收时定位。 */
export function expectEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}（期望 ${String(expected)}，实际 ${String(actual)}）`);
  }
}

/** 深相等断言：用 JSON 形状比较（夹具只比较 JSON 可序列化的值）。 */
export function expectDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}（期望 ${right}，实际 ${left}）`);
}

/**
 * 逐项执行一个维度：单条失败不阻断其余检查，失败原因以 detail 外显。
 * 这是「分别运行与分别报告」的最小实现——同一函数服务 CI 与人工验收。
 */
export async function runMcpAppFixtureDimension(
  dimension: McpAppFixtureDimension,
): Promise<McpAppFixtureDimensionReport> {
  const checks: McpAppFixtureCheckOutcome[] = [];
  for (const check of dimension.checks) {
    try {
      await check.run();
      checks.push({ name: check.name, ok: true });
    } catch (error) {
      checks.push({
        name: check.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { id: dimension.id, title: dimension.title, checks, ok: checks.every((entry) => entry.ok) };
}
