[CmdletBinding()]
param(
  [ValidateSet('amd64')]
  [string]$Architecture = 'amd64',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$searxngRoot = Join-Path $projectRoot 'third_party\searxng-windows'
$runtimeRoot = Join-Path $projectRoot 'apps\desktop-shell\src-tauri\resources\research\python-runtime'
$pythonVersion = '3.13.13'
$pythonArchiveName = "python-$pythonVersion-embed-$Architecture.zip"
$pythonUrl = "https://www.python.org/ftp/python/$pythonVersion/$pythonArchiveName"
$bootstrapUrl = 'https://bootstrap.pypa.io/get-pip.py'

if (-not (Test-Path (Join-Path $searxngRoot 'LICENSE'))) {
  throw "找不到已固定的 SearXNG 源码：$searxngRoot"
}

if ((Test-Path (Join-Path $runtimeRoot 'python.exe')) -and -not $Force) {
  Write-Host "SearXNG Python 运行时已存在：$runtimeRoot"
  exit 0
}

if (Test-Path $runtimeRoot) { Remove-Item -Force -Recurse $runtimeRoot }
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$downloadDirectory = Join-Path $runtimeRoot '.downloads'
New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
$pythonArchive = Join-Path $downloadDirectory $pythonArchiveName
$getPip = Join-Path $downloadDirectory 'get-pip.py'

Write-Host "下载固定 CPython 嵌入式运行时：$pythonUrl"
Invoke-WebRequest -UseBasicParsing -Uri $pythonUrl -OutFile $pythonArchive
Expand-Archive -Force -Path $pythonArchive -DestinationPath $runtimeRoot

$pth = Get-ChildItem -Path $runtimeRoot -Filter 'python*._pth' | Select-Object -First 1
if (-not $pth) { throw '未找到 CPython 嵌入式 _pth 配置文件。' }
$pthContent = Get-Content -Raw $pth.FullName
$pthContent = $pthContent -replace '(?m)^#import site$', 'import site'
if ($pthContent -notmatch '(?m)^Lib/site-packages$') { $pthContent = "Lib/site-packages`r`n$pthContent" }
Set-Content -NoNewline -Encoding ascii -Path $pth.FullName -Value $pthContent

$python = Join-Path $runtimeRoot 'python.exe'
Write-Host "下载 pip 引导程序：$bootstrapUrl"
Invoke-WebRequest -UseBasicParsing -Uri $bootstrapUrl -OutFile $getPip
& $python $getPip --no-warn-script-location

$coreRequirements = Join-Path $searxngRoot 'requirements.txt'
Write-Host '安装 SearXNG 固定核心依赖（仅接受预编译 Windows wheels）…'
& $python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -r $coreRequirements

$manifest = [ordered]@{
  schemaVersion = 1
  pythonVersion = $pythonVersion
  architecture = $Architecture
  pythonUrl = $pythonUrl
  pythonSha256 = (Get-FileHash -Algorithm SHA256 $pythonArchive).Hash
  searxngCommit = '9fea41204fdfa7a5cfa15b0ebd12904c520478ce'
  searxngLicense = 'AGPL-3.0'
  preparedAtUtc = [DateTime]::UtcNow.ToString('o')
  packages = @(& $python -m pip freeze)
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $runtimeRoot 'runtime-manifest.json')
Copy-Item -Force (Join-Path $searxngRoot 'LICENSE') (Join-Path $runtimeRoot 'SEARXNG-AGPL-3.0.txt')
Remove-Item -Force -Recurse $downloadDirectory
Write-Host "已准备可打包的 SearXNG Python 运行时：$runtimeRoot"
