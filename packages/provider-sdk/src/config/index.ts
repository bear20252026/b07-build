// 一个文件=一种作用：配置注册层的导出边界。
// 本层铁律：零 IO、零网络。任何 `node:` / `fetch` / 文件系统访问都属于越界。
export * from './types.js';
export * from './option-map.js';
export * from './registry.js';
export * from './capability/index.js';
export * from './official-provider-presets.js';
export * from './builtin-provider-definitions.js';
