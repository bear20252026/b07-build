<#
.SYNOPSIS
  Builds a Windows x64 Setup.exe candidate for the AI Work OS native-host helper.
.DESCRIPTION
  The script first creates the existing quarantined helper candidate, then embeds only its helper
  binary in an Inno Setup per-user installer. It never runs the installer, signs or timestamps an
  output, imports certificates, starts the helper, registers a service, changes bridge trust, or
  activates components.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$')]
  [string]$Version,

  [Parameter(Mandatory = $false)]
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

  [Parameter(Mandatory = $false)]
  [string]$OutputRoot = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'artifacts\windows-x64'),

  [Parameter(Mandatory = $false)]
  [string]$InnoCompilerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$helperId = 'awo-native-host-helper'
$binaryName = 'awo-native-host-helper.exe'
$candidateBuilder = Join-Path $RepositoryRoot 'scripts\windows\build-release-candidate.ps1'
$setupDefinition = Join-Path $RepositoryRoot 'installers\windows\awo-native-host-helper.iss'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw 'Setup.exe candidate packaging only supports Windows.' }
if (-not (Test-Path -LiteralPath $candidateBuilder -PathType Leaf)) { throw 'Windows helper candidate packager is missing.' }
if (-not (Test-Path -LiteralPath $setupDefinition -PathType Leaf)) { throw 'Inno Setup definition is missing.' }

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}
function Resolve-InnoCompiler([string]$RequestedPath) {
  $paths = @()
  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) { $paths += $RequestedPath }
  $paths += @(
    'C:\Program Files (x86)\Inno Setup 7\ISCC.exe',
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
  )
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return (Resolve-Path -LiteralPath $path).Path }
  }
  throw 'Inno Setup command-line compiler (ISCC.exe) was not found. Install Inno Setup 6+ or provide -InnoCompilerPath.'
}

& $candidateBuilder -Version $Version -RepositoryRoot $RepositoryRoot -OutputRoot $OutputRoot
if (-not $?) { throw 'Windows helper candidate packaging failed.' }

$candidateDirectory = Join-Path $OutputRoot "$helperId-$Version-windows-x64"
$candidateArchive = "$candidateDirectory.zip"
$binaryPath = Join-Path $candidateDirectory $binaryName
$candidateManifestPath = Join-Path $candidateDirectory 'release-manifest.json'
if (-not (Test-Path -LiteralPath $candidateDirectory -PathType Container)) { throw 'Expected helper candidate directory was not produced.' }
if (-not (Test-Path -LiteralPath $candidateArchive -PathType Leaf)) { throw 'Expected helper candidate ZIP was not produced.' }
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw 'Expected helper binary was not produced.' }
if (-not (Test-Path -LiteralPath $candidateManifestPath -PathType Leaf)) { throw 'Expected helper candidate manifest was not produced.' }

$candidateManifest = [System.IO.File]::ReadAllText($candidateManifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($candidateManifest.signingStatus -ne 'unsigned-candidate' -or $candidateManifest.canInstall -ne $false -or $candidateManifest.canAutoTrust -ne $false -or $candidateManifest.canActivateComponents -ne $false) { throw 'Source candidate attempts a prohibited trust or installation transition.' }
$binaryDigest = Get-Sha256 $binaryPath
$declaredBinary = @($candidateManifest.artifacts | Where-Object { $_.name -eq $binaryName })
if ($declaredBinary.Count -ne 1 -or $declaredBinary[0].sha256 -ne $binaryDigest) { throw 'Source candidate manifest does not bind the helper digest.' }

$setupDirectory = Join-Path $OutputRoot 'setup'
if (Test-Path -LiteralPath $setupDirectory) { throw "Refusing to overwrite an existing Setup.exe candidate directory: $setupDirectory" }
New-Item -ItemType Directory -Path $setupDirectory -ErrorAction Stop | Out-Null
$compiler = Resolve-InnoCompiler $InnoCompilerPath
$outputBaseName = "AI-Work-OS-Native-Host-Helper-$Version-Installer"

& $compiler "/DAppVersion=$Version" "/DSourceBinary=$binaryPath" "/DOutputDirectory=$setupDirectory" "/DOutputBaseName=$outputBaseName" $setupDefinition
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE." }

$setupPath = Join-Path $setupDirectory "$outputBaseName.exe"
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw 'Inno Setup did not produce the expected installer executable.' }
$setupDigest = Get-Sha256 $setupPath
$candidateArchiveDigest = Get-Sha256 $candidateArchive
$compilerVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).ProductVersion
$manifest = [ordered]@{
  schemaVersion = 1
  packageId = $helperId
  version = $Version
  platform = 'windows'
  architecture = 'x64'
  packageType = 'inno-setup-exe'
  channel = 'development-installable-candidate'
  signingStatus = 'unsigned-candidate'
  generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  sourceCandidate = [ordered]@{
    archiveFileName = (Split-Path -Leaf $candidateArchive)
    archiveSha256 = $candidateArchiveDigest
    helperFileName = $binaryName
    helperSha256 = $binaryDigest
  }
  installer = [ordered]@{
    fileName = (Split-Path -Leaf $setupPath)
    sha256 = $setupDigest
    compiler = 'Inno Setup'
    compilerVersion = $compilerVersion
  }
  installationPolicy = [ordered]@{
    scope = 'per-user'
    defaultDirectory = '%LOCALAPPDATA%\\Programs\\AI Work OS\\Native Host Helper'
    requiresElevation = $false
    createsUninstaller = $true
    launchesProgram = $false
    registersService = $false
    registersAutostart = $false
    registersProtocolHandler = $false
    changesEnvironment = $false
  }
  canAutoTrust = $false
  canActivateComponents = $false
  canPromoteRelease = $false
}
$manifestPath = Join-Path $setupDirectory 'setup-manifest.json'
Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 10)
$manifestDigest = Get-Sha256 $manifestPath
@(
  "$setupDigest  $(Split-Path -Leaf $setupPath)",
  "$manifestDigest  setup-manifest.json"
) | Set-Content -LiteralPath (Join-Path $setupDirectory 'SHA256SUMS.txt') -Encoding ASCII

[ordered]@{
  installer = $setupPath
  installerSha256 = $setupDigest
  manifest = $manifestPath
  packageType = 'inno-setup-exe'
  signingStatus = 'unsigned-candidate'
  canAutoTrust = $false
  canActivateComponents = $false
  releasePromotionBlocked = $true
} | ConvertTo-Json -Compress
