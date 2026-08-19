/**
 * 可演进模块化单体的静态依赖规则。
 * 轻量 architecture-check 负责运行时不可见的文本边界；本配置负责 TS/JS import 图与循环依赖。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '所有模块必须保持无循环依赖，确保零件可独立演进。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'workbench-must-use-browser-dto-boundary',
      severity: 'error',
      comment: 'Workbench 只能依赖 Protocol 和本地 runtime client，不能导入领域实现。',
      from: { path: '^apps/workbench/src' },
      to: { path: '^packages/(agent-runtime|provider-sdk|knowledge-workflow)/src' },
    },
    {
      name: 'domain-must-not-depend-on-apps',
      severity: 'error',
      comment: '领域包、Rust 控制面与 sidecar 不得反向依赖 Gateway 或 Workbench。',
      from: { path: '^(packages|crates|sidecars)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'routes-must-not-import-infrastructure-adapters',
      severity: 'error',
      comment: 'HTTP routes 只能调用显式注入的控制面和 DTO，不得直接导入 SQLite adapter。',
      from: { path: '^apps/runtime-gateway/src/http/routes/' },
      to: { path: '^packages/.*/src/infrastructure/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'] },
    reporterOptions: { dot: { collapsePattern: 'node_modules' } },
  },
};
