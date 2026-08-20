<#
.SYNOPSIS
  Read-only verifier for a development-only self-signed helper copy.
.DESCRIPTION
  This verifier checks the receipt, file digests, and embedded Authenticode signature. A valid
  result means only that the local self-signing receipt is internally consistent. It never imports
  the certificate, changes trust stores, executes the helper, installs software, or promotes a release.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
  [string]$DevelopmentDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedFiles = @('awo-native-host-helper.exe', 'development-self-signing-receipt.json')
$files = @(Get-ChildItem -LiteralPath $DevelopmentDirectory -File | Select-Object -ExpandProperty Name | Sort-Object)
if (@(Compare-Object -ReferenceObject ($expectedFiles | Sort-Object) -DifferenceObject $files).Count -ne 0) { throw 'Development signing directory file set is not allowlisted.' }

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$binaryPath = Join-Path $DevelopmentDirectory 'awo-native-host-helper.exe'
$receiptPath = Join-Path $DevelopmentDirectory 'development-self-signing-receipt.json'
$receiptJson = [System.IO.File]::ReadAllText($receiptPath, [System.Text.Encoding]::UTF8)
$receipt = $receiptJson | ConvertFrom-Json

if ($receipt.schemaVersion -ne 1 -or $receipt.mode -ne 'self-signed-development-only') { throw 'Development signing receipt schema or mode is invalid.' }
if ($receipt.publicTrust -ne $false -or $receipt.canInstall -ne $false -or $receipt.canAutoTrust -ne $false -or $receipt.canActivateComponents -ne $false -or $receipt.canPromoteRelease -ne $false -or $receipt.githubAttestationRequiredForProvenance -ne $true) { throw 'Development signing receipt attempts a prohibited trust or release transition.' }
if ($receipt.certificate.privateKeyExportable -ne $false -or $receipt.certificate.subject -ne 'CN=AI Work OS Development Only') { throw 'Development signing certificate constraints are invalid.' }
if ($receipt.output.fileName -ne 'awo-native-host-helper.exe' -or $receipt.output.sha256 -notmatch '^[a-f0-9]{64}$' -or $receipt.input.sha256 -notmatch '^[a-f0-9]{64}$' -or $receipt.certificate.thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Development signing receipt shape is invalid.' }
if ((Get-Sha256 $binaryPath) -ne $receipt.output.sha256) { throw 'Development signed helper digest does not match the receipt.' }

$signature = Get-AuthenticodeSignature -LiteralPath $binaryPath
if ($null -eq $signature.SignerCertificate) { throw 'Development signed helper has no signer certificate.' }
if ($signature.SignerCertificate.Thumbprint -ne $receipt.certificate.thumbprint) { throw 'Development signature signer thumbprint does not match the receipt.' }
if ($signature.SignerCertificate.Subject -ne $receipt.certificate.subject -or $signature.SignerCertificate.Issuer -ne $receipt.certificate.subject) { throw 'Development signature is not self-signed by the receipt subject.' }
if ($signature.Status -in @('NotSigned', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible')) { throw "Development signature is invalid: $($signature.Status) $($signature.StatusMessage)" }

[ordered]@{
  valid = $true
  mode = 'self-signed-development-only'
  signatureStatus = [string]$signature.Status
  publicTrust = $false
  canInstall = $false
  canAutoTrust = $false
  canActivateComponents = $false
  canPromoteRelease = $false
} | ConvertTo-Json -Compress
