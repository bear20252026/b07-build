// 一个文件=一种作用：MCP Apps 分维夹具的维度登记与整段运行入口。
//
// 把三个维度收进一个登记表，供两处复用：
//   - CI：`apps/workbench/test/mcp-app-*-fixture.test.ts` 逐维、逐项断言；
//   - 人工验收：`apps/workbench/mcp-app-fixture.html`（真实 WebView2）逐维渲染通过/失败。
// 维度之间互不依赖，可分别运行、分别报告——这是本批次的核心价值。

import {
  runMcpAppFixtureDimension,
  type McpAppFixtureDimension,
  type McpAppFixtureDimensionReport,
} from './dimension-report';
import { RETENTION_DIMENSION } from './retention-dimension';
import { STORAGE_DIMENSION } from './storage-dimension';
import { SAMPLING_DIMENSION } from './sampling-dimension';

export * from './dimension-report';
export { RETENTION_DIMENSION } from './retention-dimension';
export { STORAGE_DIMENSION } from './storage-dimension';
export { SAMPLING_DIMENSION } from './sampling-dimension';

/** 三个维度按 retention → storage → sampling 登记（顺序即报告顺序）。 */
export const MCP_APP_FIXTURE_DIMENSIONS: readonly McpAppFixtureDimension[] = [
  RETENTION_DIMENSION,
  STORAGE_DIMENSION,
  SAMPLING_DIMENSION,
];

/** 分别运行全部维度，返回各自的报告（维度之间不共享状态）。 */
export function runAllMcpAppFixtureDimensions(): Promise<McpAppFixtureDimensionReport[]> {
  return Promise.all(MCP_APP_FIXTURE_DIMENSIONS.map((dimension) => runMcpAppFixtureDimension(dimension)));
}
