import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const packageManifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/package.json'), 'utf8')) as Record<string, unknown>;
const cargoManifest = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/Cargo.toml'), 'utf8');
const desktopConfig = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/tauri.conf.json'), 'utf8')) as Record<string, unknown>;
const capability = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/capabilities/main-window.json'), 'utf8')) as Record<string, unknown>;
const desktopCore = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/lib.rs'), 'utf8');
const desktopMain = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/main.rs'), 'utf8');
const workbenchVite = readFileSync(resolve(root, 'apps/workbench/vite.config.ts'), 'utf8');

test('桌面壳只加载本地 Workbench 静态产物并生成每用户 Windows NSIS 安装器', () => {
  assert.equal(packageManifest.name, '@awo/desktop-shell');
  const build = desktopConfig.build as Record<string, unknown>;
  const bundle = desktopConfig.bundle as Record<string, unknown>;
  const windows = bundle.windows as Record<string, unknown>;
  const nsis = windows.nsis as Record<string, unknown>;
  assert.equal(build.frontendDist, '../../workbench/dist');
  assert.ok(String(build.beforeBuildCommand).includes('@awo/workbench'));
  assert.deepEqual(bundle.targets, ['nsis']);
  assert.equal(nsis.installMode, 'currentUser');
  assert.equal((windows.webviewInstallMode as Record<string, unknown>).type, 'downloadBootstrapper');
  assert.equal('externalBin' in bundle, false);
  assert.ok(workbenchVite.includes("base: './'"));
});

test('桌面 WebView CSP 仅允许 bundle 内容、数据图像和既有 loopback Gateway', () => {
  const app = desktopConfig.app as Record<string, unknown>;
  const security = app.security as Record<string, unknown>;
  const csp = String(security.csp);
  for (const expected of ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "connect-src 'self' http://127.0.0.1:4318"]) {
    assert.ok(csp.includes(expected), `CSP 缺少约束：${expected}`);
  }
  for (const forbidden of ['https://', 'http://localhost', "script-src 'unsafe-eval'", 'connect-src *']) {
    assert.equal(csp.includes(forbidden), false, `CSP 不得放宽为远程或通配连接：${forbidden}`);
  }
});

test('桌面 Rust 核心和 capability 不暴露 IPC 命令、shell、文件系统、sidecar、自动启动或 Gateway/helper 生命周期', () => {
  assert.deepEqual(capability.permissions, ['core:default']);
  assert.deepEqual(capability.windows, ['main']);
  for (const forbidden of [
    '#[tauri::command]', 'invoke_handler', 'tauri_plugin_', 'sidecar(', 'std::process', 'Command::',
    'std::fs', 'tokio::fs', 'ShellExt', 'runtime_gateway', 'tauri_plugin_autostart', 'tauri_plugin_deep_link', 'tauri_plugin_updater',
  ]) assert.equal(desktopCore.includes(forbidden), false, `桌面核心不得包含特权集成：${forbidden}`);
  assert.equal(cargoManifest.includes('tauri-plugin-'), false, '桌面 crate 不得引入特权 Tauri 插件');
  assert.ok(desktopMain.includes('windows_subsystem = "windows"'));
});
