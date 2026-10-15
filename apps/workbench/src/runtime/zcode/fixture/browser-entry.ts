// 一个文件=一种作用：MCP Apps 分维夹具的浏览器入口（真实 WebView2 人工验收）。
//
// 打开方式见 `docs/testing/mcp-app-dimension-fixture.md`。本入口不参与 CI、不进入工作台
// 生产包（只被 `apps/workbench/mcp-app-fixture.html` 引用，vite build 的默认入口仍是 index.html）。
//
// 它把三个维度分别渲染成三块：每块一个「运行本维度」按钮，逐项列出通过/失败与失败原因；
// 顶部另有「全部运行」。三个维度互不依赖，可单独运行——与上游 retention/storage/sampling
// 分别驱动、分别产出 results.json 的分维语义一致。

import {
  MCP_APP_FIXTURE_DIMENSIONS,
  runMcpAppFixtureDimension,
  type McpAppFixtureDimensionReport,
} from './index';

const root = document.getElementById('mcp-app-fixture-root');

/** 逐项渲染一个维度的报告：通过打勾、失败打叉并附原因。 */
function renderReport(report: McpAppFixtureDimensionReport): HTMLElement {
  const section = document.createElement('section');
  section.dataset.dimension = report.id;
  section.dataset.ok = String(report.ok);

  const heading = document.createElement('h2');
  heading.textContent = `${report.ok ? '✅' : '❌'} ${report.id} — ${report.title}`;
  section.append(heading);

  const list = document.createElement('ul');
  for (const check of report.checks) {
    const item = document.createElement('li');
    item.dataset.ok = String(check.ok);
    item.textContent = `${check.ok ? '✓' : '✗'} ${check.name}${check.ok || !check.detail ? '' : ` — ${check.detail}`}`;
    list.append(item);
  }
  section.append(list);

  const summary = document.createElement('p');
  const passed = report.checks.filter((check) => check.ok).length;
  summary.textContent = `${passed}/${report.checks.length} 项通过`;
  section.append(summary);
  return section;
}

/** 运行一个维度并把报告渲染进指定容器，同时把逐项结果打到控制台便于复制。 */
async function runDimensionInto(
  dimensionId: string,
  container: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  const dimension = MCP_APP_FIXTURE_DIMENSIONS.find((entry) => entry.id === dimensionId);
  if (!dimension) throw new Error(`unknown-dimension:${dimensionId}`);
  button.disabled = true;
  button.textContent = '运行中…';
  try {
    const report = await runMcpAppFixtureDimension(dimension);
    container.replaceChildren(renderReport(report));
    for (const check of report.checks) {
      console.log(`[${report.id}] ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` :: ${check.detail}` : ''}`);
    }
  } finally {
    button.disabled = false;
    button.textContent = '重新运行';
  }
}

if (root) {
  const heading = document.createElement('h1');
  heading.textContent = 'MCP Apps 分维夹具（人工验收）';
  const intro = document.createElement('p');
  intro.textContent =
    '三个维度分别运行、分别报告：retention（离屏回收/容量/忙碌保活）、storage（跨重挂载保持/身份隔离）、sampling（宿主代表应用发起请求的准入与代际绑定）。';
  root.append(heading, intro);

  const runAll = document.createElement('button');
  runAll.type = 'button';
  runAll.textContent = '全部运行';
  root.append(runAll);

  const sections = new Map<string, { container: HTMLElement; button: HTMLButtonElement }>();
  for (const dimension of MCP_APP_FIXTURE_DIMENSIONS) {
    const block = document.createElement('section');
    const blockHeading = document.createElement('h2');
    blockHeading.textContent = dimension.title;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '运行本维度';
    const container = document.createElement('div');
    block.append(blockHeading, button, container);
    root.append(block);
    sections.set(dimension.id, { container, button });
    button.addEventListener('click', () => {
      void runDimensionInto(dimension.id, container, button);
    });
  }

  runAll.addEventListener('click', () => {
    for (const [id, { container, button }] of sections) {
      void runDimensionInto(id, container, button);
    }
  });

  // 供自动化/脚本驱动：`window.mcpAppFixture.run('retention')` 返回该维度的报告。
  (window as unknown as { mcpAppFixture?: unknown }).mcpAppFixture = {
    dimensions: MCP_APP_FIXTURE_DIMENSIONS.map((dimension) => dimension.id),
    run: async (dimensionId: string): Promise<McpAppFixtureDimensionReport> => {
      const dimension = MCP_APP_FIXTURE_DIMENSIONS.find((entry) => entry.id === dimensionId);
      if (!dimension) throw new Error(`unknown-dimension:${dimensionId}`);
      return runMcpAppFixtureDimension(dimension);
    },
  };
}
