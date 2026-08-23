[CmdletBinding()]
param(
  [string]$Query = 'AI Work OS'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot 'apps\desktop-shell\src-tauri\resources\research\python-runtime'
$python = Join-Path $runtimeRoot 'python.exe'
$source = Join-Path $projectRoot 'third_party\searxng-windows'
$verificationRoot = Join-Path $projectRoot 'artifacts\searxng-runtime-verification'

if (-not (Test-Path $python)) { throw "Embedded Python runtime was not found: $python" }
if (-not (Test-Path (Join-Path $source 'searx'))) { throw "SearXNG source resource was not found: $source" }

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
New-Item -ItemType Directory -Force -Path $verificationRoot | Out-Null
$settings = Join-Path $verificationRoot 'settings.yml'
$secret = [Guid]::NewGuid().ToString('N')
$settingsContent = @"
use_default_settings: true
server:
  bind_address: "127.0.0.1"
  port: $port
  secret_key: "$secret"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
"@
Set-Content -NoNewline -Encoding ascii -Path $settings -Value $settingsContent

$oldSettings = $env:SEARXNG_SETTINGS_PATH
$oldPythonPath = $env:PYTHONPATH
$env:SEARXNG_SETTINGS_PATH = $settings
$env:PYTHONPATH = $source
$process = Start-Process -PassThru -NoNewWindow -WorkingDirectory $source -FilePath $python -ArgumentList @('-m', 'searx.webapp')
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $result = Invoke-RestMethod -TimeoutSec 4 -Uri "http://127.0.0.1:$port/search?q=$([Uri]::EscapeDataString($Query))&format=json"
      if ($null -ne $result.results) {
        $receipt = [ordered]@{ port = $port; query = $Query; sourceCount = @($result.results).Count; checkedAtUtc = [DateTime]::UtcNow.ToString('o') }
        $receipt | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $verificationRoot 'verification-receipt.json')
        Write-Host "SearXNG local JSON search succeeded with $(@($result.results).Count) results on loopback port $port."
        exit 0
      }
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  throw 'SearXNG did not serve a local JSON response before the startup deadline.'
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  $env:SEARXNG_SETTINGS_PATH = $oldSettings
  $env:PYTHONPATH = $oldPythonPath
}
