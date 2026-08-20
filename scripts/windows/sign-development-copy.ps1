<#
.SYNOPSIS
  Creates a self-signed, development-only copy of the Windows native-host helper.
.DESCRIPTION
  This script is intentionally for local learning and development only. It signs a NEW copy of an
  extracted candidate helper with a non-exportable CurrentUser certificate. It never signs the
  immutable candidate ZIP, imports a root certificate, installs software, changes bridge trust,
  activates components, or makes the output publicly trusted.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$CandidateBinary,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^I_ACKNOWLEDGE_DEVELOPMENT_ONLY$')]
  [string]$AcknowledgeDevelopmentOnly,

  [Parameter(Mandatory = $false)]
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $CandidateBinary).Path) 'development-self-signed')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedName = 'awo-native-host-helper.exe'
$expectedSubject = 'CN=AI Work OS Development Only'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw 'Development self-signing only supports Windows.' }
if ((Split-Path -Leaf $CandidateBinary) -ne $expectedName) { throw "Development self-signing only accepts $expectedName from an extracted candidate package." }
if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing to overwrite an existing development-signing output directory: $OutputDirectory" }

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$sourcePath = (Resolve-Path -LiteralPath $CandidateBinary).Path
$sourceDigest = Get-Sha256 $sourcePath
New-Item -ItemType Directory -Path $OutputDirectory -ErrorAction Stop | Out-Null
$signedPath = Join-Path $OutputDirectory $expectedName
Copy-Item -LiteralPath $sourcePath -Destination $signedPath -ErrorAction Stop

# The private key is deliberately non-exportable and remains in the local CurrentUser certificate store.
$certificate = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $expectedSubject `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy NonExportable `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddDays(30)

$signatureResult = Set-AuthenticodeSignature -LiteralPath $signedPath -Certificate $certificate -HashAlgorithm SHA256
$observed = Get-AuthenticodeSignature -LiteralPath $signedPath
if ($null -eq $observed.SignerCertificate) { throw 'Development signature did not include a signer certificate.' }
if ($observed.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) { throw 'Development signature certificate thumbprint does not match the generated certificate.' }
if ($observed.SignerCertificate.Subject -ne $expectedSubject -or $observed.SignerCertificate.Issuer -ne $expectedSubject) { throw 'Development signing certificate is not self-signed with the expected subject.' }
if ($observed.Status -in @('NotSigned', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible')) { throw "Development signature is unusable: $($observed.Status) $($observed.StatusMessage)" }

$signedDigest = Get-Sha256 $signedPath
$receipt = [ordered]@{
  schemaVersion = 1
  mode = 'self-signed-development-only'
  generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  input = [ordered]@{ fileName = $expectedName; sha256 = $sourceDigest }
  output = [ordered]@{ fileName = $expectedName; sha256 = $signedDigest }
  certificate = [ordered]@{
    subject = $certificate.Subject
    thumbprint = $certificate.Thumbprint
    notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
    privateKeyExportable = $false
  }
  signatureObservation = [ordered]@{
    status = [string]$observed.Status
    statusMessage = [string]$observed.StatusMessage
    signingCommandStatus = [string]$signatureResult.Status
  }
  publicTrust = $false
  canInstall = $false
  canAutoTrust = $false
  canActivateComponents = $false
  canPromoteRelease = $false
  githubAttestationRequiredForProvenance = $true
}
Write-Utf8NoBom (Join-Path $OutputDirectory 'development-self-signing-receipt.json') ($receipt | ConvertTo-Json -Depth 8)

[ordered]@{
  signedCopy = $signedPath
  receipt = (Join-Path $OutputDirectory 'development-self-signing-receipt.json')
  signingMode = 'self-signed-development-only'
  publicTrust = $false
  releasePromotionBlocked = $true
} | ConvertTo-Json -Compress
