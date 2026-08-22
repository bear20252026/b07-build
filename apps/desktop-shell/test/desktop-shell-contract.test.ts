import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const packageManifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/package.json'), 'utf8')) as Record<string, unknown>;
const rootPackageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
const cargoManifest = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/Cargo.toml'), 'utf8');
const desktopConfig = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/tauri.conf.json'), 'utf8')) as Record<string, unknown>;
const capability = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/capabilities/main-window.json'), 'utf8')) as Record<string, unknown>;
const companionCapability = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/capabilities/desktop-companion-window.json'), 'utf8')) as Record<string, unknown>;
const desktopCore = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/lib.rs'), 'utf8');
const directProvider = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/direct_provider.rs'), 'utf8');
const desktopMain = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/main.rs'), 'utf8');
const workbenchVite = readFileSync(resolve(root, 'apps/workbench/vite.config.ts'), 'utf8');
const workbenchSider = readFileSync(resolve(root, 'apps/workbench/src/components/layout/Sider.tsx'), 'utf8');

function csp(): string {
  const app = desktopConfig.app as Record<string, unknown>;
  return String((app.security as Record<string, unknown>).csp);
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
  for (const expected of ['mod direct_provider;', 'DirectProviderState::new()', 'configure_direct_provider', 'discover_direct_provider', 'start_direct_provider_stream', 'install_desktop_tray', 'TrayIconBuilder', 'show_desktop_companion', 'close_desktop_companion', 'WindowEvent::CloseRequested', 'app.exit(0)']) assert.ok(desktopCore.includes(expected), `桌面核心缺少：${expected}`);
  for (const expected of ['OpenaiCompatible', 'AnthropicCompatible', '/v1/chat/completions', '/v1/messages', 'text/event-stream', 'direct-provider-stream', 'api-key', 'x-api-key']) assert.ok(directProvider.includes(expected), `直接 Provider 缺少：${expected}`);
  for (const forbidden of ['start_local_gateway', 'GATEWAY_ADDRESS', 'GATEWAY_SIDECAR', 'tauri_plugin_shell::init()', 'sidecar(']) assert.equal(desktopCore.includes(forbidden), false, `桌面核心不得包含 Gateway 依赖：${forbidden}`);
  assert.ok(cargoManifest.includes('reqwest'), '直接 HTTPS/SSE 请求需要原生 HTTP 客户端');
  assert.ok(cargoManifest.includes('tray-icon'), '桌面常驻入口需要 Tauri tray-icon');
  assert.equal(cargoManifest.includes('tauri-plugin-shell'), false, '不得保留 sidecar shell plugin');
  assert.ok(desktopMain.includes('windows_subsystem = "windows"'));
});

test('桌面 Workbench 使用静态 AW 标记而不引入要求 unsafe-eval 的图标运行时代码', () => {
  assert.ok(workbenchSider.includes('sider-brand-initials'));
  assert.equal(workbenchSider.includes('@lobehub/icons'), false);
});
