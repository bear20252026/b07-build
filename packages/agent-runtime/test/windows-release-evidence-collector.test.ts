import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const scriptPath = resolve(process.cwd(), 'sidecars/windows-native-host/collect-release-evidence.ps1');

test('Windows-only release evidence collector 只包含固定 Authenticode/Hash 读取与脱敏 DTO，不包含启动、安装、签名或信任操作', () => {
  const script = readFileSync(scriptPath, 'utf8');
  for (const required of [
    "[System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT",
    'Get-FileHash -Algorithm SHA256 -LiteralPath $HelperPath',
    'Get-AuthenticodeSignature -LiteralPath $HelperPath',
    'Get-CimInstance -ClassName Win32_Processor',
    'signerThumbprintDigest = Get-Sha256Hex $thumbprint',
    'canExecute = $false',
    'canAutoTrust = $false',
  ]) assert.ok(script.includes(required), `collector 缺少固定安全约束：${required}`);
  for (const forbidden of ['Start-Process', 'Invoke-Expression', 'Set-AuthenticodeSignature', 'Import-Certificate', 'Install-', 'Add-Type', 'New-Service', 'Remove-Item']) {
    assert.equal(script.includes(forbidden), false, `collector 不得包含执行性命令：${forbidden}`);
  }
  for (const sensitive of ['helperPath = $HelperPath', 'SignerCertificate.Subject', 'signature = $signature', 'thumbprint = $thumbprint']) {
    assert.equal(script.includes(sensitive), false, `collector 输出不得包含敏感字段：${sensitive}`);
  }
});
