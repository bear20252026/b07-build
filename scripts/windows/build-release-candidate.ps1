#requires -Version 5.1
<#!
.SYNOPSIS
  Builds an unsigned, quarantined AI Work OS Windows x64 native-host helper candidate package.
.DESCRIPTION
  This script produces a local ZIP candidate with a helper binary, SPDX 2.2 SBOM, hashes, manifest, and read-only verifier.
  It never signs, timestamps, installs, starts the helper, imports certificates, changes bridge trust, or activates components.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$')]
  [string]$Version,

  [Parameter(Mandatory = $false)]
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [Parameter(Mandatory = $false)]
  [string]$OutputRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'artifacts\windows-x64')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$target = 'x86_64-pc-windows-msvc'
$helperId = 'awo-native-host-helper'
$crateDir = Join-Path $RepositoryRoot 'crates\windows-native-host-helper'
$helperPath = Join-Path $crateDir "target\$target\release\awo-native-host-helper.exe"
$verifyScript = Join-Path $RepositoryRoot 'scripts\windows\VERIFY-CANDIDATE.ps1'
$stage = Join-Path $OutputRoot "awo-native-host-helper-$Version-windows-x64"
$archive = "$stage.zip"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw 'Windows candidate packaging only supports Windows.' }
if (-not (Test-Path -LiteralPath $crateDir -PathType Container)) { throw 'Native host helper crate is missing.' }
if (-not (Test-Path -LiteralPath $verifyScript -PathType Leaf)) { throw 'Candidate verifier is missing.' }
if (Test-Path -LiteralPath $stage) { throw "Candidate staging directory already exists: $stage" }
if (Test-Path -LiteralPath $archive) { throw "Candidate archive already exists: $archive" }

Push-Location $crateDir
try {
  & cargo build --locked --release --target $target
  if ($LASTEXITCODE -ne 0) { throw 'Cargo failed to build the Windows x64 helper candidate.' }
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'Expected Windows helper binary was not produced.' }

New-Item -ItemType Directory -Path $stage -Force | Out-Null
$binaryName = 'awo-native-host-helper.exe'
$binaryDestination = Join-Path $stage $binaryName
# `$stage` is rejected when it already exists, so Copy-Item cannot overwrite a prior candidate package.
Copy-Item -LiteralPath $helperPath -Destination $binaryDestination
Copy-Item -LiteralPath $verifyScript -Destination (Join-Path $stage 'VERIFY-CANDIDATE.ps1')

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}
$binaryDigest = Get-Sha256 $binaryDestination
$created = [DateTimeOffset]::UtcNow.ToString('o')
$sbom = [ordered]@{
  spdxVersion = 'SPDX-2.2'
  SPDXID = 'SPDXRef-DOCUMENT'
  name = "AI-Work-OS-Windows-Native-Host-Helper-$Version"
  documentNamespace = "https://ai-work-os.local/spdx/windows-native-host-helper/$Version/$([Guid]::NewGuid().ToString())"
  creationInfo = [ordered]@{ created = $created; creators = @('Tool: AI Work OS candidate packager'); licenseListVersion = '3.25' }
  dataLicense = 'CC0-1.0'
  packages = @([ordered]@{
    SPDXID = 'SPDXRef-Package-AwoNativeHostHelper'; name = $helperId; versionInfo = $Version; downloadLocation = 'NOASSERTION'; filesAnalyzed = $true
    licenseConcluded = 'MIT'; licenseDeclared = 'MIT'; copyrightText = 'NOASSERTION'
    checksums = @([ordered]@{ algorithm = 'SHA256'; checksumValue = $binaryDigest })
  })
  files = @([ordered]@{
    SPDXID = 'SPDXRef-File-AwoNativeHostHelper'; fileName = "./$binaryName"; checksums = @([ordered]@{ algorithm = 'SHA256'; checksumValue = $binaryDigest })
    licenseConcluded = 'MIT'; copyrightText = 'NOASSERTION'
  })
  relationships = @([ordered]@{ spdxElementId = 'SPDXRef-DOCUMENT'; relationshipType = 'DESCRIBES'; relatedSpdxElement = 'SPDXRef-Package-AwoNativeHostHelper' })
}
$sbomPath = Join-Path $stage 'sbom.spdx.json'
Write-Utf8NoBom $sbomPath ($sbom | ConvertTo-Json -Depth 12)
$sbomDigest = Get-Sha256 $sbomPath

$manifest = [ordered]@{
  schemaVersion = 1
  packageId = 'awo-native-host-helper'
  version = $Version
  platform = 'windows'
  architecture = 'x64'
  target = $target
  protocolVersion = 'native-host.v1'
  channel = 'candidate'
  signingStatus = 'unsigned-candidate'
  canInstall = $false
  canAutoTrust = $false
  canActivateComponents = $false
  generatedAt = $created
  artifacts = @(
    [ordered]@{ name = $binaryName; sha256 = $binaryDigest; mediaType = 'application/vnd.microsoft.portable-executable' },
    [ordered]@{ name = 'sbom.spdx.json'; sha256 = $sbomDigest; mediaType = 'application/spdx+json' }
  )
}
$manifestPath = Join-Path $stage 'release-manifest.json'
Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 8)
$manifestDigest = Get-Sha256 $manifestPath

@(
  "$binaryDigest  $binaryName"
  "$sbomDigest  sbom.spdx.json"
  "$manifestDigest  release-manifest.json"
) | Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Encoding ASCII

& $verifyScript -CandidateDirectory $stage
if ($LASTEXITCODE -ne 0) { throw 'Candidate self-verification failed.' }
# PowerShell 5.1 Compress-Archive accepts `-Path`; inputs are the fixed files emitted into a newly created staging directory.
Compress-Archive -Path (Get-ChildItem -LiteralPath $stage -File | Select-Object -ExpandProperty FullName) -DestinationPath $archive -CompressionLevel Optimal
$archiveDigest = Get-Sha256 $archive
"$archiveDigest  $(Split-Path -Leaf $archive)" | Set-Content -LiteralPath "$archive.SHA256SUMS.txt" -Encoding ASCII

[ordered]@{
  package = $archive
  packageSha256 = $archiveDigest
  stagingDirectory = $stage
  signingStatus = 'unsigned-candidate'
  releasePromotionBlocked = $true
} | ConvertTo-Json -Compress
