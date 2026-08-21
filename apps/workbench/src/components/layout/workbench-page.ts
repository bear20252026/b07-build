/**
 * Workbench 唯一的前端页面意图集合。
 *
 * 该纯 TypeScript 模块可被布局投影、测试和 React 侧栏共同使用；它不携带路由、Gateway
 * 或权限逻辑，避免非 JSX TypeScript 构建依赖 TSX 组件实现。
 */
export type WorkbenchPage = 'workspace' | 'projects' | 'task' | 'models' | 'connections' | 'operations' | 'api-usage' | 'capabilities' | 'agency-roles' | 'security';
