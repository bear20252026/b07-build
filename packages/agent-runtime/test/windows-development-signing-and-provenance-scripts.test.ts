import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const developmentSigner = readFileSync(resolve(root, 'scripts/windows/sign-development-copy.ps1'), 'utf8');
const developmentVerifier = readFileSync(resolve(root, 'scripts/windows/VERIFY-DEVELOPMENT-SELF-SIGNING.ps1'), 'utf8');
const provenanceWorkflow = readFileSync(resolve(root, '.github/workflows/windows-native-host-provenance.yml'), 'utf8');

test('开发自签名只生成不可导出私钥的副本，并锁死为非公开受信状态', () => {
  for (const required of [
    "ValidatePattern('^I_ACKNOWLEDGE_DEVELOPMENT_ONLY$')",
    "New-SelfSignedCertificate",
    "-Type CodeSigningCert",
    "-CertStoreLocation 'Cert:\\CurrentUser\\My'",
    '-KeyLength 3072',
    '-KeyExportPolicy NonExportable',
    'Set-AuthenticodeSignature',
    'Get-AuthenticodeSignature',
    "mode = 'self-signed-development-only'",
    'publicTrust = $false',
    'canInstall = $false',
    'canAutoTrust = $false',
    'canActivateComponents = $false',
    'canPromoteRelease = $false',
    'githubAttestationRequiredForProvenance = $true',
  ]) assert.ok(developmentSigner.includes(required), `开发自签名脚本缺少约束：${required}`);
  for (const forbidden of ['Import-Certificate', 'Import-PfxCertificate', 'Add-AppxPackage', 'Start-Process', 'Invoke-Expression', 'New-ItemProperty', 'Cert:\\LocalMachine\\Root']) {
    assert.equal(developmentSigner.includes(forbidden), false, `开发自签名脚本不得包含信任/安装/执行副作用：${forbidden}`);
  }
});

test('开发自签名验证器仅审计签名和收据，拒绝任何信任或发布提升', () => {
  for (const required of [
    "'awo-native-host-helper.exe'",
    "'development-self-signing-receipt.json'",
    'Get-AuthenticodeSignature',
    '[System.IO.File]::ReadAllText($receiptPath, [System.Text.Encoding]::UTF8)',
    'Get-FileHash -LiteralPath $Path -Algorithm SHA256',
    "'self-signed-development-only'",
    '$receipt.publicTrust -ne $false',
    '$receipt.canPromoteRelease -ne $false',
  ]) assert.ok(developmentVerifier.includes(required), `开发自签名验证器缺少约束：${required}`);
  for (const forbidden of ['Import-Certificate', 'Add-AppxPackage', 'Set-AuthenticodeSignature', 'Start-Process', 'Invoke-Expression']) {
    assert.equal(developmentVerifier.includes(forbidden), false, `开发自签名验证器不得包含副作用：${forbidden}`);
  }
});

test('GitHub Windows provenance 工作流只构建候选包并生成 SLSA 来源证明', () => {
  for (const required of [
    'workflow_dispatch:',
    'windows-latest',
    'contents: read',
    'id-token: write',
    'attestations: write',
    'build-setup-candidate.ps1',
    'VERIFY-CANDIDATE.ps1',
    'VERIFY-SETUP-CANDIDATE.ps1',
    'choco install InnoSetup --version=6.7.1',
    'actions/upload-artifact@v4',
    'name: awo-native-host-helper-windows-x64-candidates',
    'actions/attest@v4',
    'subject-path: ${{ steps.package.outputs.archive }}',
    'subject-path: ${{ steps.package.outputs.installer }}',
  ]) assert.ok(provenanceWorkflow.includes(required), `来源证明工作流缺少约束：${required}`);
  for (const forbidden of ['sign-development-copy.ps1', 'Set-AuthenticodeSignature', 'New-SelfSignedCertificate', 'Import-Certificate', 'Add-AppxPackage', 'gh release create', 'Start-Process', '& $installer']) {
    assert.equal(provenanceWorkflow.includes(forbidden), false, `来源证明工作流不得包含签名/安装/发布副作用：${forbidden}`);
  }
});
