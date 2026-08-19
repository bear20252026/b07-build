import type { HttpRequestContext } from './boundary.js';
import type { GatewayDependencies } from './gateway-dependencies.js';

/** 单个路由族的输入，只暴露已解析 HTTP 请求与 composition root 显式注入的依赖。 */
export interface GatewayRouteContext extends HttpRequestContext {
  readonly dependencies: GatewayDependencies;
}

/** 返回 true 表示该路由族已经发送响应；返回 false 交由下一条路由管道处理。 */
export type GatewayRoute = (context: GatewayRouteContext) => Promise<boolean>;
