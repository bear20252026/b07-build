// 一个文件=一种作用：工作台侧的 provider 离线目录出口。
// 目录数据与查询规则已迁入 `@awo/provider-sdk` 的纯配置层（零 IO）；
// 这里只做转发，保证工作台与桌面直连不再各留一份会漂移的厂商清单。
// 走 `./browser` 入口：展示层不得触达 provider-sdk 的 src（分层约束）。

export type { OfficialProviderPreset } from '@awo/provider-sdk/browser';
export { OFFICIAL_PROVIDER_PRESETS, officialModelsForProvider } from '@awo/provider-sdk/browser';
