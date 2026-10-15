// 一个文件=一种作用：provider-sdk 公共导出边界（三层并列）。
// 三层依赖方向固定：config（零 IO）← catalog（可注入 fetch）← execution（失败分类/重试/密钥保护）。
// 浏览器侧只允许消费 `./config` 与 `./execution`；`./catalog` 需要注入传输，不应进 UI 包。
export * from './config/index.js';
export * from './catalog/index.js';
export * from './execution/index.js';
