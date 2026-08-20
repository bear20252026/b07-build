import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const packager = readFileSync(resolve(root, 'scripts/windows/build-release-candidate.ps1'), 'utf8');
const verifier = readFileSync(resolve(root, 'scripts/windows/VERIFY-CANDIDATE.ps1'), 'utf8');

test('Windows candidate packager 固定 x64 target、候选状态、SBOM 和摘要，并禁止发布/信任副作用', () => {
  for (const required of [
    "$target = 'x86_64-pc-windows-msvc'",
    'cargo build --locked --release --target $target',
    "signingStatus = 'unsigned-candidate'",
    'canInstall = $false',
    'canAutoTrust = $false',
    'canActivateComponents = $false',
    "spdxVersion = 'SPDX-2.2'",
    'Get-FileHash -LiteralPath $Path -Algorithm SHA256',
    '& $verifyScript -CandidateDirectory $stage',
  ]) assert.ok(packager.includes(required), `packager 缺少受控候选包约束：${required}`);
  for (const forbidden of ['SignTool sign', 'Set-AuthenticodeSignature', 'Start-Process', 'Import-Certificate', 'Add-AppxPackage', 'winget install', 'Invoke-Expression']) {
    assert.equal(packager.includes(forbidden), false, `packager 不得包含发布/执行副作用：${forbidden}`);
  }
});

test('Windows candidate verifier 只验证 allowlist 文件、manifest/SBOM/摘要，且禁止执行或信任升级', () => {
  for (const required of [
    "'awo-native-host-helper.exe'", "'release-manifest.json'", "'sbom.spdx.json'", "'SHA256SUMS.txt'",
    "$manifest.signingStatus -ne 'unsigned-candidate'", 'Get-FileHash -LiteralPath $Path -Algorithm SHA256', "'SPDX-2.2'",
  ]) assert.ok(verifier.includes(required), `verifier 缺少候选包验证约束：${required}`);
  for (const forbidden of ['Start-Process', 'Add-AppxPackage', '& SignTool', 'Import-Certificate', 'Set-AuthenticodeSignature', 'Invoke-Expression']) {
    assert.equal(verifier.includes(forbidden), false, `verifier 不得包含执行/发布副作用：${forbidden}`);
  }
});
