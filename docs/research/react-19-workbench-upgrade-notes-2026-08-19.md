# React 19 工作台升级审查

**日期：2026-08-19**

React 官方升级指南要求同时升级 `react`、`react-dom` 及其 TypeScript 类型，并要求采用现代 JSX transform。[1] 当前工作台唯一的 React 消费者是 `apps/workbench`，已使用 Vite 的 `react-jsx` transform 和 `react-dom/client` 的 `createRoot`，没有 `ReactDOM.render`、legacy context、string ref、`findDOMNode`、`react-dom/test-utils` 或 `useRef()` 无参数调用，因此无需源码 API codemod。

| 审查项 | 当前状态 | 升级处理 |
| --- | --- | --- |
| React 消费范围 | 仅 `@awo/workbench` 声明 React/React DOM | 将该工作区与类型包锁定升级至 React 19。 |
| 根 API | `createRoot(rootEl).render(...)` | 已符合 React 19。 |
| JSX transform | TypeScript `react-jsx` 与 Vite React 插件 | 已符合 React 19。 |
| 旧图标包替代 | `@lobehub/icons-static-svg` 无 peer 依赖 | 切换至正式 `@lobehub/icons` 组件包，并移除静态包。 |
| 运行时验证 | 现有工作台已通过浏览器渲染 | 升级后重新执行类型检查、生产构建、浏览器双主题/双语验证与完整回归。 |

> 结论：该工作台体量小且 API 已现代化，React 19 升级可局限在单一前端 workspace；仍须以构建和浏览器验证确认 `@lobehub/icons` 的实际组件导出与 peer 依赖一致。

## References

[1] [React 19 Upgrade Guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)

## 验证结果

升级后，工作台生产构建成功（12171 个模块转换），全量 TypeScript 回归测试为 78/78 通过。浏览器在 React 19 下成功渲染侧栏的 `LobeHub` 正式 React 图标组件，未出现 Hooks、peer dependency 或渲染错误；中文 LocaleProvider 文案与石墨主题布局保持正常。验证完成后已停止 Vite 开发服务器以释放资源。
