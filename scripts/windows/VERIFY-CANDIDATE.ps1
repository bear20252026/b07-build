#requires -Version 5.1
<#!
.SYNOPSIS
  Read-only verifier for an AI Work OS Windows x64 native-host candidate directory.
.DESCRIPTION
  The verifier checks package metadata and hashes only. It never runs the helper, installs a package,
  imports certificates, calls SignTool signing, changes bridge trust, or activates components.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
  [string]$CandidateDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedNames = @('awo-native-host-helper.exe', 'release-manifest.json', 'sbom.spdx.json', 'SHA256SUMS.txt', 'VERIFY-CANDIDATE.ps1')
$files = @(Get-ChildItem -LiteralPath $CandidateDirectory -File | Select-Object -ExpandProperty Name | Sort-Object)
if (@(Compare-Object -ReferenceObject ($expectedNames | Sort-Object) -DifferenceObject $files).Count -ne 0) { throw 'Candidate directory file set is not allowlisted.' }

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$manifestPath = Join-Path $CandidateDirectory 'release-manifest.json'
$sbomPath = Join-Path $CandidateDirectory 'sbom.spdx.json'
$sumPath = Join-Path $CandidateDirectory 'SHA256SUMS.txt'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$sbom = Get-Content -LiteralPath $sbomPath -Raw | ConvertFrom-Json

if ($manifest.schemaVersion -ne 1 -or $manifest.packageId -ne 'awo-native-host-helper' -or $manifest.platform -ne 'windows' -or $manifest.architecture -ne 'x64' -or $manifest.target -ne 'x86_64-pc-windows-msvc' -or $manifest.protocolVersion -ne 'native-host.v1') { throw 'Candidate manifest identity is invalid.' }
if ($manifest.channel -ne 'candidate' -or $manifest.signingStatus -ne 'unsigned-candidate' -or $manifest.canInstall -ne $false -or $manifest.canAutoTrust -ne $false -or $manifest.canActivateComponents -ne $false) { throw 'Candidate manifest attempts a prohibited release or trust transition.' }
if ($manifest.artifacts.Count -ne 2) { throw 'Candidate manifest artifact count is invalid.' }

$declared = @{}
foreach ($line in Get-Content -LiteralPath $sumPath) {
  if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$') { throw 'SHA256SUMS format is invalid.' }
  $declared[$Matches[2]] = $Matches[1]
}
foreach ($name in @('awo-native-host-helper.exe', 'sbom.spdx.json', 'release-manifest.json')) {
  if (-not $declared.ContainsKey($name)) { throw "Missing hash entry for $name." }
  if ((Get-Sha256 (Join-Path $CandidateDirectory $name)) -ne $declared[$name]) { throw "Hash mismatch for $name." }
}

$binary = @($manifest.artifacts | Where-Object { $_.name -eq 'awo-native-host-helper.exe' })
$sbomArtifact = @($manifest.artifacts | Where-Object { $_.name -eq 'sbom.spdx.json' })
if ($binary.Count -ne 1 -or $sbomArtifact.Count -ne 1 -or $binary[0].sha256 -ne $declared['awo-native-host-helper.exe'] -or $sbomArtifact[0].sha256 -ne $declared['sbom.spdx.json']) { throw 'Manifest artifact digests do not match SHA256SUMS.' }
$sbomFile = @($sbom.files | Where-Object { $_.fileName -eq './awo-native-host-helper.exe' })
if ($sbom.spdxVersion -ne 'SPDX-2.2' -or $sbomFile.Count -ne 1 -or $sbomFile[0].checksums[0].algorithm -ne 'SHA256' -or $sbomFile[0].checksums[0].checksumValue -ne $declared['awo-native-host-helper.exe']) { throw 'SBOM does not bind the helper binary digest.' }

[ordered]@{ valid = $true; platform = 'windows'; architecture = 'x64'; signingStatus = 'unsigned-candidate'; canInstall = $false; canAutoTrust = $false; canActivateComponents = $false } | ConvertTo-Json -Compress
