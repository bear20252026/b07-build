import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const packageManifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/package.json'), 'utf8')) as Record<string, unknown>;
const rootPackageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
const cargoManifest = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/Cargo.toml'), 'utf8');
const desktopConfig = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/tauri.conf.json'), 'utf8')) as Record<string, unknown>;
const macosDesktopConfig = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/tauri.macos.conf.json'), 'utf8')) as Record<string, unknown>;
const androidConfig = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/tauri.android.conf.json'), 'utf8')) as Record<string, unknown>;
const capability = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/capabilities/main-window.json'), 'utf8')) as Record<string, unknown>;
const companionCapability = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/capabilities/desktop-companion-window.json'), 'utf8')) as Record<string, unknown>;
const desktopCore = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/lib.rs'), 'utf8');
const nativePlatformClient = readFileSync(resolve(root, 'apps/workbench/src/runtime/native-platform.ts'), 'utf8');
const directProvider = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/direct_provider.rs'), 'utf8');
const searxngLocal = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/searxng_local.rs'), 'utf8');
const desktopMain = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/main.rs'), 'utf8');
const workbenchVite = readFileSync(resolve(root, 'apps/workbench/vite.config.ts'), 'utf8');
const workbenchSider = readFileSync(resolve(root, 'apps/workbench/src/components/layout/Sider.tsx'), 'utf8');
const workbenchApp = readFileSync(resolve(root, 'apps/workbench/src/App.tsx'), 'utf8');
const haloSearch = readFileSync(resolve(root, 'apps/workbench/src/components/layout/HaloSearch.tsx'), 'utf8');
const startupSplash = readFileSync(resolve(root, 'apps/workbench/src/components/layout/StartupSplash.tsx'), 'utf8');
const chatHome = readFileSync(resolve(root, 'apps/workbench/src/components/workspace/ChatHome.tsx'), 'utf8');
const homeModelSwitching = readFileSync(resolve(root, 'apps/workbench/src/runtime/home-model-switching.ts'), 'utf8');
const providerDiagnostics = readFileSync(resolve(root, 'apps/workbench/src/runtime/provider-diagnostics.ts'), 'utf8');
const searchRunCard = readFileSync(resolve(root, 'apps/workbench/src/runtime/search-run-card.ts'), 'utf8');
const webSearch = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/web_search.rs'), 'utf8');
const externalUrl = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/external_url.rs'), 'utf8');
const assistantArtifacts = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/assistant_artifacts.rs'), 'utf8');
const artifactProjection = readFileSync(resolve(root, 'apps/workbench/src/components/preview/artifact-extension-projection.ts'), 'utf8');
const artifactExtension = readFileSync(resolve(root, 'apps/workbench/src/components/preview/ArtifactExtensionPanel.tsx'), 'utf8');
const directConversations = readFileSync(resolve(root, 'apps/workbench/src/runtime/use-direct-conversations.ts'), 'utf8');
const workbenchCss = readFileSync(resolve(root, 'apps/workbench/src/workbench.css'), 'utf8');
const macosWorkflow = readFileSync(resolve(root, '.github/workflows/macos-desktop-shell-provenance.yml'), 'utf8');
const androidWorkflow = readFileSync(resolve(root, '.github/workflows/nova-android-provenance.yml'), 'utf8');

function csp(): string {
  const app = desktopConfig.app as Record<string, unknown>;
  return String((app.security as Record<string, unknown>).csp);
}

function functionSlice(signature: string, nextSignature: string): string {
  const start = desktopCore.indexOf(signature);
  assert.notEqual(start, -1, `未找到函数：${signature}`);
  const end = desktopCore.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `未找到函数边界：${nextSignature}`);
  return desktopCore.slice(start, end);
}

test('桌面壳加载本地 Workbench 静态产物并生成每用户 Windows NSIS 安装器，不打包 Gateway sidecar', () => {
  assert.equal(packageManifest.name, '@awo/desktop-shell');
  assert.equal((packageManifest.scripts as Record<string, unknown>).tauri, 'tauri');
  const build = desktopConfig.build as Record<string, unknown>;
  const bundle = desktopConfig.bundle as Record<string, unknown>;
  const windows = bundle.windows as Record<string, unknown>;
  assert.equal(build.frontendDist, '../../workbench/dist');
  assert.ok(String(build.beforeBuildCommand).includes('@awo/workbench'));
  assert.deepEqual(bundle.targets, ['nsis']);
  assert.equal((windows.nsis as Record<string, unknown>).installMode, 'currentUser');
  assert.equal(bundle.externalBin, undefined);
  assert.equal(rootPackageManifest.scripts?.['gateway:sidecar'], undefined);
  assert.ok(workbenchVite.includes("base: './'"));
});

test('macOS arm64 候选使用独立 DMG workflow、ad-hoc 候选签名和无 Windows Python 的资源覆盖，不影响 Windows NSIS workflow', () => {
  const macosBundle = macosDesktopConfig.bundle as Record<string, unknown>;
  const macosConfig = macosBundle.macOS as Record<string, unknown>;
  const resources = macosBundle.resources as Record<string, unknown>;
  assert.deepEqual(macosBundle.targets, ['dmg']);
  assert.deepEqual(macosBundle.icon, ['icons/icon.icns']);
  assert.equal(macosConfig.minimumSystemVersion, '11.0');
  assert.equal(macosConfig.signingIdentity, '-');
  assert.equal(resources['resources/research/python-runtime/'], null);
  assert.equal(Object.values(resources).some((value) => String(value).includes('python-runtime')), false);
  assert.ok(existsSync(resolve(root, 'apps/desktop-shell/src-tauri/icons/icon.icns')));
  for (const expected of ['runs-on: macos-latest', 'aarch64-apple-darwin', 'nova-macos-arm64-desktop-shell-candidate', "platform\": \"macos-arm64", 'ad-hoc-candidate', 'bundlesWindowsPythonRuntime']) assert.ok(macosWorkflow.includes(expected), `macOS workflow 缺少：${expected}`);
  const windowsWorkflow = readFileSync(resolve(root, '.github/workflows/windows-desktop-shell-provenance.yml'), 'utf8');
  assert.ok(windowsWorkflow.includes('runs-on: windows-latest'));
  assert.equal(windowsWorkflow.includes('macos-desktop-shell-provenance'), false);
  assert.ok(searxngLocal.includes('searxng-macos-runtime-unavailable'));
  assert.ok(desktopCore.includes('desktop-companion-macos-unavailable'));
});

test('Android 使用独立 NOVA 包标识、手机尺寸、PNG 图标和无 Windows Python 资源的配置', () => {
  const androidBundle = androidConfig.bundle as Record<string, unknown>;
  const androidSettings = androidBundle.android as Record<string, unknown>;
  const resources = androidBundle.resources as Record<string, unknown>;
  const app = androidConfig.app as Record<string, unknown>;
  const windows = app.windows as readonly Record<string, unknown>[];
  assert.equal(androidConfig.productName, 'NOVA');
  assert.equal(androidConfig.identifier, 'com.bear20252026.nova');
  assert.equal(androidSettings.minSdkVersion, 24);
  assert.equal(androidSettings.versionCode, 1018);
  assert.deepEqual(androidBundle.icon, ['icons/icon.png']);
  assert.deepEqual(androidBundle.externalBin, []);
  for (const value of Object.values(resources)) assert.equal(value, null, 'Android 不得打入桌面 Python/研究资源');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].width, 390);
  assert.equal(windows[0].height, 844);
  assert.equal(rootPackageManifest.scripts?.['android:build:apk'], 'npm exec --workspace=@awo/desktop-shell -- tauri android build --apk --target aarch64');
  assert.equal(rootPackageManifest.scripts?.['android:build:aab'], 'npm exec --workspace=@awo/desktop-shell -- tauri android build --aab');
});

test('桌面 WebView CSP 不开放远程 HTTP 通讯；第三方请求由 Tauri 原生 Provider 客户端直接发出', () => {
  const value = csp();
  for (const expected of ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "connect-src 'self'"]) assert.ok(value.includes(expected), `CSP 缺少约束：${expected}`);
  for (const forbidden of ['127.0.0.1:4318', 'https://', 'http://localhost', "script-src 'unsafe-eval'", 'connect-src *']) assert.equal(value.includes(forbidden), false, `CSP 不得开放：${forbidden}`);
});

test('桌面 Rust 核心提供直接 OpenAI/Anthropic Provider、模型查询、SSE 文本事件与系统托盘，不授予通用 shell 权限', () => {
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.permissions, ['core:default']);
  assert.deepEqual(companionCapability.windows, ['desktop-companion']);
  assert.deepEqual(companionCapability.permissions, ['core:default']);
  for (const expected of ['mod direct_provider;', 'DirectProviderState::new()', 'configure_direct_provider', 'discover_direct_provider', 'probe_direct_provider', 'start_direct_provider_stream', 'desktop_diagnostics', 'searxng_local_status', 'install_desktop_tray', 'TrayIconBuilder', 'show_desktop_companion', 'hide_desktop_companion', 'close_desktop_companion', '.transparent(true)', '.always_on_top(true)', '.skip_taskbar(true)', 'WindowEvent::CloseRequested', 'app.exit(0)']) assert.ok(desktopCore.includes(expected), `桌面核心缺少：${expected}`);
  for (const expected of ['OpenaiCompatible', 'AnthropicCompatible', '/v1/chat/completions', '/v1/messages', 'text/event-stream', 'direct-provider-stream', 'api-key', 'x-api-key']) assert.ok(directProvider.includes(expected), `直接 Provider 缺少：${expected}`);
  for (const forbidden of ['start_local_gateway', 'GATEWAY_ADDRESS', 'GATEWAY_SIDECAR', 'tauri_plugin_shell::init()', 'sidecar(']) assert.equal(desktopCore.includes(forbidden), false, `桌面核心不得包含 Gateway 依赖：${forbidden}`);
  assert.ok(cargoManifest.includes('reqwest'), '直接 HTTPS/SSE 请求需要原生 HTTP 客户端');
  assert.ok(cargoManifest.includes('tray-icon'), '桌面常驻入口需要 Tauri tray-icon');
  assert.equal(cargoManifest.includes('tauri-plugin-shell'), false, '不得保留 sidecar shell plugin');
  assert.ok(desktopMain.includes('windows_subsystem = "windows"'));
});

test('Android 移动入口复用 Rust 直接 Provider HTTPS/SSE 与受限 HTTP(S) 外部链接，但不注册桌面命令', () => {
  const mobileStart = desktopCore.indexOf('#[cfg(mobile)]\n#[tauri::mobile_entry_point]');
  assert.notEqual(mobileStart, -1, '缺少 Android/iOS Tauri 入口');
  const mobile = desktopCore.slice(mobileStart);
  for (const expected of ['tauri_plugin_opener::init()', 'DirectProviderState::new()', 'configure_direct_provider', 'discover_direct_provider', 'probe_direct_provider', 'start_direct_provider_stream', 'external_url::open_external_url', 'native_runtime_platform']) assert.ok(mobile.includes(expected), `Android 移动入口缺少：${expected}`);
  for (const forbidden of ['terminal::', 'show_desktop_companion', 'assistant_artifacts::', 'searxng_local::', 'last30days::', 'hybrid_search::', 'tauri_plugin_dialog::init()']) assert.equal(mobile.includes(forbidden), false, `Android 移动入口不得注册桌面能力：${forbidden}`);
  assert.equal(mobile.includes('MAIN_WINDOW_LABEL'), false, 'Android 移动入口不得引用桌面主窗口常量');
  assert.ok(externalUrl.includes('tauri_plugin_opener::open_url'));
  assert.ok(externalUrl.includes('#[cfg(not(mobile))]'));
  assert.ok(externalUrl.includes('external-url-invalid'));
  assert.ok(cargoManifest.includes('tauri-plugin-opener'));
  for (const expected of ['platform: "android"', 'supports_direct_provider: true', 'supports_terminal: false', 'supports_desktop_companion: false', 'supports_desktop_save_as: false', 'supports_local_python_research: false']) assert.ok(desktopCore.includes(expected), `Android 能力回执缺少：${expected}`);
  for (const expected of ["'android' | 'desktop' | 'web'", "invoke('native_runtime_platform')", 'supportsLocalPythonResearch']) assert.ok(nativePlatformClient.includes(expected), `Workbench 移动平台客户端缺少：${expected}`);
});

test('Android 候选构建链独立产出 NOVA aarch64 APK、universal AAB、临时签名、哈希清单与 SLSA provenance', () => {
  for (const expected of [
    'workflow_dispatch:',
    'runs-on: ubuntu-latest',
    'aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android',
    'npm run android:init',
    'npm run android:build:apk',
    'npm run android:build:aab',
    'NOVA_${version}_aarch64-candidate.apk',
    'NOVA_${version}_universal-candidate.aab',
    'nova-android-candidate-manifest.json',
    'ephemeral-test-signed-release-candidate',
    'rust-reqwest-https-sse',
    'includesWindowsGatewaySidecar',
    'includesLocalPythonSearchRuntime',
    'actions/attest@v4',
  ]) assert.ok(androidWorkflow.includes(expected), `Android workflow 缺少：${expected}`);
  assert.equal(androidWorkflow.includes('push:\n'), false, 'Android 候选工作流在稳定前不得因推送自动触发');
  assert.equal(androidWorkflow.includes('AI Work OS'), false, 'Android 候选工作流不得保留旧产品名称');
  assert.equal(existsSync(resolve(root, '.github/workflows/android-apk-candidate.yml')), false, '不得保留旧 AI Work OS Android workflow');
  const windowsWorkflow = readFileSync(resolve(root, '.github/workflows/windows-desktop-shell-provenance.yml'), 'utf8');
  assert.equal(windowsWorkflow.includes('nova-android-provenance'), false, 'Windows 工作流不得耦合 Android 构建');
  assert.equal(macosWorkflow.includes('nova-android-provenance'), false, 'macOS 工作流不得耦合 Android 构建');
});

test('桌面宠物默认由明确动作显示，独立隐藏或关闭不会接管工作台或 Provider 直连聊天', () => {
  const show = functionSlice('fn show_desktop_companion', 'fn hide_desktop_companion');
  const hide = functionSlice('fn hide_desktop_companion', 'fn close_desktop_companion');
  const close = functionSlice('fn close_desktop_companion', 'fn install_desktop_tray');
  assert.ok(show.includes('.transparent(true)'));
  assert.ok(show.includes('.always_on_top(true)'));
  assert.ok(show.includes('.skip_taskbar(true)'));
  assert.equal(show.includes('MAIN_WINDOW_LABEL'), false, '显示宠物不得读取、隐藏或聚焦主工作台');
  assert.equal(show.includes('direct_provider'), false, '显示宠物不得发起 Provider 请求');
  assert.ok(hide.includes('window.hide()'));
  assert.equal(hide.includes('direct_provider'), false, '隐藏宠物不得发起 Provider 请求');
  assert.ok(close.includes('hide_desktop_companion(app.clone())'));
  assert.match(close, /main_window\s*\.show\(\)/);
  assert.match(close, /main_window\s*\.set_focus\(\)/);
  assert.ok(desktopCore.includes('window.label() == DESKTOP_COMPANION_WINDOW_LABEL'));
  assert.ok(desktopCore.includes('api.prevent_close()'));
});

test('P0 诊断只读取本地状态，不启动 SearXNG、不暴露密钥、聊天正文或文件路径', () => {
  assert.ok(desktopCore.includes('It neither starts SearXNG nor exposes paths'));
  assert.ok(desktopCore.includes('AI_WORK_OS_SOURCE_REVISION'));
  assert.ok(searxngLocal.includes('pub fn searxng_local_status'));
  assert.ok(searxngLocal.includes('X-Forwarded-For'));
  assert.ok(searxngLocal.includes('STARTUP_TIMEOUT_SECONDS: u64 = 35'));
  assert.equal(desktopCore.includes('api_key'), false);
});

test('明确 /github 命令只在本地打开确认式 GitHub 协作面板，不进入 Provider 聊天发送', () => {
  assert.ok(workbenchApp.includes('resolveGitHubCollaborationIntent'));
  assert.ok(workbenchApp.includes("setInspectorSurface('github-collaboration')"));
  assert.ok(workbenchApp.includes('const githubIntent = resolveGitHubCollaborationIntent(goal)'));
  assert.ok(workbenchApp.includes('directConversations.send(taskModelSelection, goal'));
});

test('首页可明确选择任意已连接厂商与模型，并提供无敏感 Provider 时间线和搜索重试预填', () => {
  for (const expected of ['MODEL CONNECTION · DIRECT', '首页厂商连接', '首页模型标识', 'onSelectTaskModel', '不会修改地址、密钥或自动改用其他厂商']) assert.ok(chatHome.includes(expected), `首页缺少模型切换契约：${expected}`);
  for (const expected of ['homeModelChoices', 'isSelectableHomeModel', 'officialModelsForProvider', 'mimo-v2.5', 'mimo-v2.5-pro']) assert.ok(homeModelSwitching.includes(expected), `首页模型选择缺少：${expected}`);
  const officialCatalog = readFileSync(resolve(root, 'apps/workbench/src/runtime/official-provider-catalog.ts'), 'utf8');
  for (const expected of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', "id: 'kimi'", 'kimi-k2.7-code', "id: 'baidu-qianfan'", 'ernie-5.1', "id: 'baichuan'", 'Baichuan4-Turbo', "id: 'sensenova'", 'SenseChat-5', "id: 'doubao-ark'", "id: 'minimax'", "id: 'stepfun'", "id: 'iflytek-spark'"]) assert.ok(officialCatalog.includes(expected), `官方 Provider 目录缺少：${expected}`);
  for (const expected of ['createProviderTraceId', 'traceId', '不包含 API key、提示词、回复、图片数据或代理地址']) assert.ok(providerDiagnostics.includes(expected), `Provider 时间线缺少：${expected}`);
  for (const expected of ['SearchRunCard', 'onPrepareSearchRetry', '准备以同一后端重试']) assert.ok(chatHome.includes(expected), `搜索运行卡缺少：${expected}`);
  assert.ok(searchRunCard.includes('searchRunMode'));
  assert.ok(workbenchApp.includes('const prepareSearchRetry'));
  assert.ok(workbenchApp.includes('setWebSearchEnabled(true)'));
});

test('模型目录仅作为可选辅助能力，连接测试必须调用已配置模型的真实聊天端点', () => {
  assert.ok(directProvider.includes('headers.insert(ACCEPT, HeaderValue::from_static("application/json"))'));
  assert.ok(directProvider.includes('subscription gateway may return an'));
  assert.match(directProvider, /return Ok\(DirectProviderModelDiscovery\s*\{\s*schema_version: 1,\s*provider_id: request\.provider_id,\s*models: Vec::new\(\),\s*\}\)/);
  assert.ok(directProvider.includes('pub async fn probe_direct_provider'));
  assert.ok(directProvider.includes('post(url_for(&session))'));
  assert.ok(directProvider.includes('Reply with OK.'));
});

test('桌面 Workbench 使用静态 NOVA 图标而不引入要求 unsafe-eval 的图标运行时代码', () => {
  assert.ok(workbenchSider.includes("import novaIcon from '../../assets/nova-icon.png'"));
  assert.ok(workbenchSider.includes('src={novaIcon}'));
  assert.equal(workbenchSider.includes('@lobehub/icons'), false);
  assert.ok(existsSync(resolve(root, 'apps/desktop-shell/src-tauri/icons/icon.ico')));
  assert.ok(existsSync(resolve(root, 'apps/desktop-shell/src-tauri/icons/128x128@2x.png')));
});

test('联网搜索每轮最多向模型投影十个 URL，且来源可见并由用户点击后在系统浏览器打开', () => {
  assert.ok(webSearch.includes('const MAX_RESULTS: usize = 10;'));
  assert.ok(searxngLocal.includes('const MAX_RESULTS: usize = 10;'));
  assert.ok(desktopCore.includes('external_url::open_external_url'));
  for (const expected of ['MAX_EXTERNAL_URL_CHARS', 'http://', 'https://', 'rundll32.exe', 'url.dll,FileProtocolHandler']) assert.ok(externalUrl.includes(expected), `外部 URL 打开边界缺少：${expected}`);
  for (const forbidden of ['tauri_plugin_shell', 'Command::new("cmd")', 'powershell.exe']) assert.equal(externalUrl.includes(forbidden), false, `外部 URL 命令不得接受或依赖：${forbidden}`);
  for (const expected of ['每轮最多 10 个 URL', 'onOpenSearchSource', 'openSearchSourceInSystemBrowser', 'overflowWrap']) assert.ok(chatHome.includes(expected) || workbenchApp.includes(expected) || directConversations.includes(expected), `来源展示或打开入口缺少：${expected}`);
});

test('连续流式助手回复必须使用独立消息 ID，不能用会话固定占位 ID 覆盖前一轮完成回复', () => {
  for (const expected of ["const streamingMessageId = nextId('message')", 'mergeStreamingAssistantMessage', 'streamingAssistantMessage(streamingMessageId']) assert.ok(directConversations.includes(expected), `会话持久化缺少：${expected}`);
  assert.equal(directConversations.includes('`${conversationId}-stream`'), false, '不得复用每会话固定 stream ID');
});

test('已保存 Markdown 只能经原生单文件 Save As 导出，WebView 不获得通用文件或 dialog 插件权限', () => {
  for (const expected of ['export_assistant_markdown_artifact', 'blocking_save_file()', 'validate_export_destination', 'assistant-artifact-export-write-failed', 'set_file_name(&display_name)']) assert.ok(assistantArtifacts.includes(expected), `Markdown 导出边界缺少：${expected}`);
  assert.ok(desktopCore.includes('assistant_artifacts::export_assistant_markdown_artifact'));
  assert.deepEqual(capability.permissions, ['core:default']);
  for (const forbidden of ['dialog:allow-save', 'tauri_plugin_fs', 'read_dir', 'Command::new']) assert.equal(assistantArtifacts.includes(forbidden), false, `Markdown 导出不得引入：${forbidden}`);
});

test('右侧项目产物框以稳定 metadata 分组历史并持久化展开状态，只按需预览或导出已保存 Markdown', () => {
  for (const expected of ['已保存 Markdown', '回复历史', '任务 / 运行记录', 'taskId', 'runId', 'createdAt']) assert.ok(artifactProjection.includes(expected), `产物历史投影缺少：${expected}`);
  for (const expected of ['EXPANDED_STORAGE_KEY', 'loadExpandedFolders', 'onExportAssistantArtifact', '导出 MD', 'previewRequest']) assert.ok(artifactExtension.includes(expected), `产物历史交互缺少：${expected}`);
  for (const forbidden of ['readDir(', 'readdir(', 'fetch(']) assert.equal(artifactExtension.includes(forbidden), false, `右侧历史不得自动扫描或联网：${forbidden}`);
});

test('Halo Search 必须位于最上层且不对标题栏施加模糊遮罩', () => {
  const layerStart = workbenchCss.indexOf('.command-palette-layer');
  const layerEnd = workbenchCss.indexOf('.command-palette {', layerStart);
  assert.notEqual(layerStart, -1);
  assert.notEqual(layerEnd, -1);
  const layer = workbenchCss.slice(layerStart, layerEnd);
  assert.ok(layer.includes('z-index: 2147483646'));
  assert.equal(layer.includes('backdrop-filter'), false);
  assert.ok(haloSearch.includes('createPortal'));
  assert.ok(haloSearch.includes('document.body'));
});

test('DeepSeek V4 Flash 必须通过可见模型候选选择器呈现，同时继续允许手动模型标识', () => {
  for (const expected of ['首页模型候选', '切换当前会话的模型候选', '模型标识（可手动输入）', 'visibleChoices']) assert.ok(chatHome.includes(expected), `首页模型候选缺少：${expected}`);
  const officialCatalog = readFileSync(resolve(root, 'apps/workbench/src/runtime/official-provider-catalog.ts'), 'utf8');
  for (const expected of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) assert.ok(officialCatalog.includes(expected), `DeepSeek 官方模型目录缺少：${expected}`);
});

test('开屏仅是有界品牌过渡，尊重 reduced-motion 且不参与 Provider、Gateway 或会话状态机', () => {
  for (const expected of ['prefers-reduced-motion: reduce', 'setTimeout(() => setVisible(false)', '1250', '跳过', 'nova-splash-orbit', 'nova-splash-breathe']) assert.ok(startupSplash.includes(expected), `开屏缺少：${expected}`);
  for (const forbidden of ['invoke(', 'directConversations', 'start_direct_provider_stream']) assert.equal(startupSplash.includes(forbidden), false, `开屏不得依赖：${forbidden}`);
  assert.ok(workbenchApp.includes('<StartupSplash />'));
});
