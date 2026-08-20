import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const setupDefinition = readFileSync(resolve(root, 'installers/windows/awo-native-host-helper.iss'), 'utf8');
const setupBuilder = readFileSync(resolve(root, 'scripts/windows/build-setup-candidate.ps1'), 'utf8');
const setupVerifier = readFileSync(resolve(root, 'scripts/windows/VERIFY-SETUP-CANDIDATE.ps1'), 'utf8');

test('Inno Setup 定义只安装 x64 helper 并提供卸载，绝不包含自动运行、注册或脚本执行段', () => {
  for (const required of [
    'AppName=AI Work OS Native Host Helper',
    'DefaultDirName={localappdata}\\Programs\\AI Work OS\\Native Host Helper',
    'PrivilegesRequired=lowest',
    'ArchitecturesAllowed=x64',
    'ArchitecturesInstallIn64BitMode=x64',
    'RestartIfNeededByRun=no',
    'Source: "{#SourceBinary}"; DestDir: "{app}"; Flags: ignoreversion',
  ]) assert.ok(setupDefinition.includes(required), `Inno Setup 定义缺少约束：${required}`);
  for (const forbidden of ['[Run]', '[UninstallRun]', '[Registry]', '[Code]', '[Tasks]', '[Icons]', 'Filename:', 'regserver', 'restartreplace', 'runhidden']) {
    assert.equal(setupDefinition.includes(forbidden), false, `Inno Setup 定义不得包含自动运行或系统注册逻辑：${forbidden}`);
  }
});

test('Setup.exe 打包器仅复用隔离候选 helper 并禁止签名、安装、启动、信任或激活副作用', () => {
  for (const required of [
    "'Inno Setup'",
    'ISCC.exe',
    'build-release-candidate.ps1',
    "signingStatus = 'unsigned-candidate'",
    "packageType = 'inno-setup-exe'",
    "channel = 'development-installable-candidate'",
    'scope = \'per-user\'',
    'requiresElevation = $false',
    'launchesProgram = $false',
    'registersService = $false',
    'registersAutostart = $false',
    'registersProtocolHandler = $false',
    'changesEnvironment = $false',
    'canAutoTrust = $false',
    'canActivateComponents = $false',
    'canPromoteRelease = $false',
  ]) assert.ok(setupBuilder.includes(required), `Setup.exe 打包器缺少受控约束：${required}`);
  for (const forbidden of ['Set-AuthenticodeSignature', 'Import-Certificate', 'Add-AppxPackage', 'Start-Process', 'Invoke-Expression', '& $setupPath', 'sc.exe create', 'schtasks']) {
    assert.equal(setupBuilder.includes(forbidden), false, `Setup.exe 打包器不得包含签名、安装、启动或信任副作用：${forbidden}`);
  }
});

test('Setup.exe 验证器只读检查清单、PE 头与摘要，并拒绝自动安装、信任、激活或发布提升', () => {
  for (const required of [
    "'inno-setup-exe'",
    "'development-installable-candidate'",
    "'unsigned-candidate'",
    '[System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)',
    "'Setup.exe SHA-256 does not match the manifest.'",
    "'Declared Setup.exe does not have a PE MZ header.'",
    'canManualInstall = $true',
    'canAutoInstall = $false',
    'canAutoTrust = $false',
    'canActivateComponents = $false',
    'canPromoteRelease = $false',
  ]) assert.ok(setupVerifier.includes(required), `Setup.exe 验证器缺少约束：${required}`);
  for (const forbidden of ['Start-Process', 'Add-AppxPackage', 'Set-AuthenticodeSignature', 'Import-Certificate', 'Invoke-Expression', '& $installerPath']) {
    assert.equal(setupVerifier.includes(forbidden), false, `Setup.exe 验证器不得执行安装器或改变信任：${forbidden}`);
  }
});
