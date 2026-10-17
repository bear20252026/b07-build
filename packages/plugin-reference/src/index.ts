// 插件 @ 引用 —— 纯包，无 IO。
//
// 三段：
// - `references`：从用户文本里**严格**解析出插件身份（身份只来自链接 destination）。
// - `catalog`：会话内冻结的插件目录，含同名冲突判定。
// - `reminder`：只含标识符的能力提示，fail closed + 上限。
//
// 不在本包做的事：解析 `@` 的界面（picker）、读插件存储、查 MCP 连接状态。
// 那些都需要真实 IO 与宿主 API —— 保持纯粹才能把"能不能提示、提示什么"完整单测。

export {
  MAX_PLUGIN_REFERENCES_PER_TURN,
  extractPluginReferences,
  isValidPluginStableId,
  type ExtractPluginReferencesResult,
} from './references.js';

export {
  buildPluginReferenceCatalog,
  findPluginCatalogEntry,
  type BuildPluginReferenceCatalogResult,
  type PluginCatalogEntry,
  type PluginCatalogSource,
  type PluginReferenceCatalog,
} from './catalog.js';

export {
  MAX_PLUGIN_REFERENCE_MCP_SERVERS,
  MAX_PLUGIN_REFERENCE_REMINDER_BYTES,
  buildPluginReferenceReminderBody,
  type BuildPluginReferenceReminderInput,
  type BuildPluginReferenceReminderResult,
  type LivePluginMcpServer,
  type PluginReferenceReminderDiagnostics,
  type PluginReferenceSkipReason,
} from './reminder.js';
