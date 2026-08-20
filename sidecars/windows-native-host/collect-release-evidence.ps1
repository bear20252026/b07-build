#requires -Version 5.1
<#!
.SYNOPSIS
  P6.5 Windows-only native host release evidence collector.
.DESCRIPTION
  This script performs only local, read-only evidence capture for one preconfigured native helper.
  It never accepts browser/HTTP input, starts a helper, changes Authenticode trust, accesses private keys,
  installs software, or writes release decisions. It emits a redacted JSON DTO for the TypeScript release gate.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')]
  [string]$IssuerId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')]
  [string]$BridgeId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')]
  [string]$HelperId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')]
  [string]$ProtocolVersion,

  # Provided exclusively by trusted Windows native adapter configuration; never map renderer/HTTP values to this parameter.
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$HelperPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'P6.5 collector only supports Windows.'
}
if ([System.IO.Path]::GetExtension($HelperPath).ToLowerInvariant() -ne '.exe') {
  throw 'P6.5 collector only accepts a configured .exe helper path.'
}

function Get-Sha256Hex([string]$Value) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Convert-AuthenticodeStatus([string]$Status) {
  switch ($Status) {
    'Valid' { return 'valid' }
    'NotSigned' { return 'not-signed' }
    'UnknownError' { return 'unknown' }
    default { return 'invalid' }
  }
}

$fileHash = Get-FileHash -Algorithm SHA256 -LiteralPath $HelperPath
$signature = Get-AuthenticodeSignature -LiteralPath $HelperPath
$thumbprint = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Thumbprint.Trim().ToUpperInvariant() }
$processorArchitecture = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Architecture)
$architecture = switch ([int]$processorArchitecture) {
  9 { 'x64' }
  12 { 'arm64' }
  0 { 'x86' }
  default { 'unknown' }
}

# Deliberately omit helper path, filename, certificate subject/body, raw status output and signatures from the JSON payload.
[ordered]@{
  schemaVersion = 1
  evidenceId = "windows-evidence:$([Guid]::NewGuid().ToString())"
  platform = 'windows'
  architecture = $architecture
  issuerId = $IssuerId
  bridgeId = $BridgeId
  helperId = $HelperId
  protocolVersion = $ProtocolVersion
  binaryDigest = $fileHash.Hash.ToLowerInvariant()
  signerThumbprintDigest = Get-Sha256Hex $thumbprint
  authenticodeStatus = Convert-AuthenticodeStatus ([string]$signature.Status)
  capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  canExecute = $false
  canAutoTrust = $false
} | ConvertTo-Json -Compress
