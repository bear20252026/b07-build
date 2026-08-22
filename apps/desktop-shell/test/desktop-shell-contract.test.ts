import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const packageManifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/package.json'), 'utf8')) as Record<string, unknown>;
const rootPackageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> };
const cargoManifest = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/Cargo.toml'), 'utf8');
const desktopConfig = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/tauri.conf.json'), 'utf8')) as Record<string, unknown>;
const androidConfig = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/tauri.android.conf.json'), 'utf8')) as Record<string, unknown>;
const capability = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/capabilities/main-window.json'), 'utf8')) as Record<string, unknown>;
const companionCapability = JSON.parse(readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/capabilities/desktop-companion-window.json'), 'utf8')) as Record<string, unknown>;
const desktopCore = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/lib.rs'), 'utf8');
const desktopMain = readFileSync(resolve(root, 'apps/desktop-shell/src-tauri/src/main.rs'), 'utf8');
const gatewayMain = readFileSync(resolve(root, 'apps/runtime-gateway/src/main.ts'), 'utf8');
const workbenchVite = readFileSync(resolve(root, 'apps/workbench/vite.config.ts'), 'utf8');
const workbenchSider = readFileSync(resolve(root, 'apps/workbench/src/components/layout/Sider.tsx'), 'utf8');
const provenanceWorkflow = readFileSync(resolve(root, '.github/workflows/windows-desktop-shell-provenance.yml'), 'utf8');
const androidWorkflow = readFileSync(resolve(root, '.github/workflows/android-apk-candidate.yml'), 'utf8');
const gatewaySidecarBuild = readFileSync(resolve(root, 'scripts/windows/build-gateway-sidecar.mjs'), 'utf8');

test('桌面壳只加载本地 Workbench 静态产物并生成每用户 Windows NSIS 安装器', () => {
  assert.equal(packageManifest.name, '@awo/desktop-shell');
  const build = desktopConfig.build as Record<string, unknown>;
  const bundle = desktopConfig.bundle as Record<string, unknown>;
  const windows = bundle.windows as Record<string, unknown>;
  const nsis = windows.nsis as Record<string, unknown>;
  assert.equal(build.frontendDist, '../../workbench/dist');
  assert.ok(String(build.beforeBuildCommand).includes('@awo/workbench'));
  assert.deepEqual(bundle.targets, ['nsis']);
  assert.deepEqual(bundle.icon, ['icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.ico']);
  assert.equal(nsis.installMode, 'currentUser');
  assert.equal((windows.webviewInstallMode as Record<string, unknown>).type, 'downloadBootstrapper');
  assert.deepEqual(bundle.externalBin, ['binaries/awo-runtime-gateway']);
  assert.ok(workbenchVite.includes("base: './'"));
});

test('Android 只通过远程 runner 初始化与构建，且不继承 Windows Gateway sidecar 或桌面 Companion 命令', () => {
  const bundle = androidConfig.bundle as Record<string, unknown>;
  const android = bundle.android as Record<string, unknown>;
  assert.deepEqual(bundle.externalBin, []);
  assert.equal(android.minSdkVersion, 24);
  assert.equal(rootPackageManifest.scripts?.['android:build:apk'], 'npm exec --workspace=@awo/desktop-shell -- tauri android build --apk --target aarch64 --target armv7');
  for (const expected of [
    'runs-on: ubuntu-latest', 'actions/setup-java@v5', 'android-actions/setup-android@v3',
    "'ndk;27.2.12479018'", 'npm run android:init', 'npm run android:build:apk',
    'includesWindowsGatewaySidecar', 'includesDesktopCompanionCommands', 'actions/upload-artifact@v7',
  ]) assert.ok(androidWorkflow.includes(expected), `Android 远程构建工作流缺少：${expected}`);
  for (const forbidden of ['gateway:sidecar', 'Start-Process', 'git push', 'contents: write']) {
    assert.equal(androidWorkflow.includes(forbidden), false, `Android 工作流不得启动 Windows sidecar 或修改仓库：${forbidden}`);
  }
  for (const expected of ['#[cfg(not(mobile))]', '#[cfg(mobile)]', '#[tauri::mobile_entry_point]', 'tauri::generate_handler![exit_ai_work_os]']) {
    assert.ok(desktopCore.includes(expected), `移动端入口缺少平台隔离：${expected}`);
  }
});

test('Windows Gateway sidecar 使用 Node 24 兼容的受控 SEA blob 注入流程', () => {
  assert.equal(rootPackageManifest.devDependencies?.postject, '1.0.0-alpha.6');
  for (const expected of [
    "'--experimental-sea-config'", "'NODE_SEA_BLOB'", "'--sentinel-fuse'", 'NODE_SEA_SENTINEL_FUSE',
    'copyFileSync(process.execPath, windowsBinaryPath)', "execArgvExtension: 'none'",
  ]) assert.ok(gatewaySidecarBuild.includes(expected), `sidecar 构建缺少 SEA 约束：${expected}`);
  assert.equal(gatewaySidecarBuild.includes("'--build-sea'"), false, 'Node 24 发布构建不得依赖未支持的 --build-sea 参数');
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

test('桌面 Workbench 使用静态 AW 标记而不引入要求 `unsafe-eval` 的图标运行时代码', () => {
  assert.ok(workbenchSider.includes('sider-brand-initials'));
  assert.equal(workbenchSider.includes('@lobehub/icons'), false, '桌面 Workbench 不得重新引入导致严格 CSP 白屏的图标运行时');
});

test('桌面 Rust 核心仅暴露固定 Gateway sidecar、固定原生工作区选择与固定标签 Companion 生命周期，不授予通用 shell、文件、自动启动或 helper 生命周期能力', () => {
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.permissions, ['core:default', { identifier: 'shell:allow-spawn', allow: [{ name: 'binaries/awo-runtime-gateway', sidecar: true, args: ['serve'] }] }]);
  assert.deepEqual(companionCapability.windows, ['desktop-companion']);
  assert.deepEqual(companionCapability.permissions, ['core:default']);
  for (const expected of [
    '#[tauri::command]', 'start_local_gateway', 'choose_workspace_directory', 'WorkspaceDirectoryState', 'show_desktop_companion', 'close_desktop_companion', 'exit_ai_work_os', 'invoke_handler', 'tauri_plugin_shell::init()', 'tauri_plugin_dialog::init()', 'blocking_pick_folder()', 'sidecar(GATEWAY_SIDECAR)', 'args(["serve"])',
    'const GATEWAY_ADDRESS: &str = "127.0.0.1:4318"', 'const GATEWAY_SIDECAR: &str = "awo-runtime-gateway"',
    'const DESKTOP_COMPANION_WINDOW_LABEL: &str = "desktop-companion"', 'WebviewWindowBuilder::new', 'WebviewUrl::App("index.html".into())',
    '.always_on_top(true)', '.skip_taskbar(true)', 'WindowEvent::CloseRequested', 'api.prevent_close()', 'window.hide()', 'app.exit(0)',
    'app_local_data_dir()', 'create_dir_all(directory.join(".awo"))', '.current_dir(data_directory)',
  ]) assert.ok(desktopCore.includes(expected), `桌面核心缺少受限 Gateway 或 Companion 约束：${expected}`);
  for (const forbidden of [
    'std::fs::', 'tokio::fs', 'std::env::', 'tauri_plugin_autostart', 'tauri_plugin_deep_link', 'tauri_plugin_updater',
    'awo-native-host-helper', 'Command::new(', 'args(["serve",',
  ]) {
    assert.equal(desktopCore.includes(forbidden), false, `桌面核心不得包含越界集成：${forbidden}`);
  }
  assert.ok(cargoManifest.includes('tauri-plugin-shell'), '固定 sidecar 启动需要唯一 shell plugin');
  assert.ok(cargoManifest.includes('tauri-plugin-dialog'), '显式原生文件/目录选择需要 Dialog plugin');
  for (const forbiddenPermission of ['fs:', 'dialog:', 'shell:allow-execute', 'shell:allow-stdin-write']) assert.equal(JSON.stringify(capability).includes(forbiddenPermission), false, `主窗口不得获得越界权限：${forbiddenPermission}`);
  assert.ok(desktopMain.includes('windows_subsystem = "windows"'));
});

test('Gateway sidecar 固定在 loopback 端口并拒绝用户参数与环境变量覆盖', () => {
  for (const expected of [
    'const FIXED_DESKTOP_GATEWAY_PORT = 4318', 'startLocalGateway(FIXED_DESKTOP_GATEWAY_PORT)',
    "argumentsAfterExecutable[0] !== 'serve'", 'process.argv.slice(2)',
  ]) assert.ok(gatewayMain.includes(expected), `Gateway sidecar 缺少固定启动约束：${expected}`);
  assert.equal(gatewayMain.includes('AWO_RUNTIME_PORT'), false, 'desktop sidecar 不得接受端口环境变量覆盖');
});

test('桌面候选来源证明工作流仅构建、上传和证明安装器，不安装或启动任何本地运行时', () => {
  for (const expected of [
    'runs-on: windows-latest', 'contents: read', 'id-token: write', 'attestations: write',
    'npm ci', 'npm run gateway:sidecar', 'npm run desktop:build', 'actions/upload-artifact@v7', 'actions/attest@v4',
    "signingStatus = 'unsigned-candidate'", 'canAutoStartGateway = $false', 'bundlesExplicitGatewaySidecar = $true',
    'canAutoStartNativeHelper = $false', 'canPromoteBridgeTrust = $false',
  ]) assert.ok(provenanceWorkflow.includes(expected), `桌面 provenance 工作流缺少：${expected}`);
  for (const forbidden of ['Start-Process', 'msiexec', 'unins', 'awo-native-host-helper', 'git push', 'contents: write']) {
    assert.equal(provenanceWorkflow.includes(forbidden), false, `桌面 provenance 工作流不得包含：${forbidden}`);
  }
});
