// 一个文件=一种作用：provider-sdk 的浏览器安全入口（展示层唯一可消费的出口）。
//
// 为什么不在 `src/` 里？因为既有分层约束（`.dependency-cruiser.cjs` 的
// `workbench-must-use-browser-dto-boundary`）明确禁止 `apps/workbench/src` 导入
// `packages/provider-sdk/src`。与其放宽策略，不如让包的形状服从策略：
// 浏览器入口与 `src` 并列，出口本身仍转发 src 中的纯层实现。
//
// 只导出零 IO、零传输的两层：配置注册层 + 执行适配层（失败分类 / 重试策略 / 密钥脱敏）。
// 远端目录层（catalog）持有注入式传输，刻意不在此导出——展示层不得直接抓取目录。

export * from '../src/config/index.js';
export * from '../src/execution/index.js';
