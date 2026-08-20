<#
.SYNOPSIS
  Read-only verifier for an AI Work OS Inno Setup.exe candidate directory.
.DESCRIPTION
  The verifier checks the installer file, manifest and SHA-256 ledger without launching Setup.exe.
  It never installs or uninstalls software, imports certificates, signs files, starts the helper,
  registers services, changes bridge trust, or activates components.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
  [string]$SetupDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$manifestPath = Join-Path $SetupDirectory 'setup-manifest.json'
$sumPath = Join-Path $SetupDirectory 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $sumPath -PathType Leaf)) { throw 'Setup candidate manifest or SHA-256 ledger is missing.' }
$manifestJson = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$manifest = $manifestJson | ConvertFrom-Json

if ($manifest.schemaVersion -ne 1 -or $manifest.packageId -ne 'awo-native-host-helper' -or $manifest.platform -ne 'windows' -or $manifest.architecture -ne 'x64' -or $manifest.packageType -ne 'inno-setup-exe') { throw 'Setup candidate identity is invalid.' }
if ($manifest.channel -ne 'development-installable-candidate' -or $manifest.signingStatus -ne 'unsigned-candidate' -or $manifest.canAutoTrust -ne $false -or $manifest.canActivateComponents -ne $false -or $manifest.canPromoteRelease -ne $false) { throw 'Setup candidate attempts a prohibited trust or release transition.' }
if ($manifest.installer.compiler -ne 'Inno Setup' -or $manifest.installer.fileName -notmatch '^AI-Work-OS-Native-Host-Helper-\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?-Installer\.exe$' -or $manifest.installer.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Setup candidate installer metadata is invalid.' }
if ($manifest.sourceCandidate.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.sourceCandidate.helperSha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.sourceCandidate.helperFileName -ne 'awo-native-host-helper.exe') { throw 'Setup candidate source provenance metadata is invalid.' }
$policy = $manifest.installationPolicy
if ($policy.scope -ne 'per-user' -or $policy.requiresElevation -ne $false -or $policy.createsUninstaller -ne $true -or $policy.launchesProgram -ne $false -or $policy.registersService -ne $false -or $policy.registersAutostart -ne $false -or $policy.registersProtocolHandler -ne $false -or $policy.changesEnvironment -ne $false) { throw 'Setup candidate installation policy is not allowlisted.' }

$installerPath = Join-Path $SetupDirectory $manifest.installer.fileName
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw 'Declared Setup.exe is missing.' }
$files = @(Get-ChildItem -LiteralPath $SetupDirectory -File | Select-Object -ExpandProperty Name | Sort-Object)
$expectedFiles = @($manifest.installer.fileName, 'setup-manifest.json', 'SHA256SUMS.txt') | Sort-Object
if (@(Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $files).Count -ne 0) { throw 'Setup candidate directory file set is not allowlisted.' }
$header = [System.IO.File]::ReadAllBytes($installerPath)[0..1]
if ($header[0] -ne 0x4d -or $header[1] -ne 0x5a) { throw 'Declared Setup.exe does not have a PE MZ header.' }
if ((Get-Sha256 $installerPath) -ne $manifest.installer.sha256) { throw 'Setup.exe SHA-256 does not match the manifest.' }

$declared = @{}
foreach ($line in Get-Content -LiteralPath $sumPath) {
  if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$') { throw 'SHA256SUMS format is invalid.' }
  $declared[$Matches[2]] = $Matches[1]
}
foreach ($name in @($manifest.installer.fileName, 'setup-manifest.json')) {
  if (-not $declared.ContainsKey($name)) { throw "Missing hash entry for $name." }
  if ((Get-Sha256 (Join-Path $SetupDirectory $name)) -ne $declared[$name]) { throw "Hash mismatch for $name." }
}

[ordered]@{
  valid = $true
  packageType = 'inno-setup-exe'
  signingStatus = 'unsigned-candidate'
  canManualInstall = $true
  canAutoInstall = $false
  canAutoTrust = $false
  canActivateComponents = $false
  canPromoteRelease = $false
} | ConvertTo-Json -Compress
