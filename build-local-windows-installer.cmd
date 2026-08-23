@echo off
setlocal EnableExtensions
set "PROJECT=D:\maanuse\AI-Work-OS-local-build"
set "LOG=%PROJECT%\local-windows-build.log"
if not exist "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" (
  echo ERROR: Visual Studio x64 build environment was not found.
  exit /b 2
)
call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%
cd /d "%PROJECT%"
echo === AI Work OS local Windows installer build === > "%LOG%"
echo Source: >> "%LOG%"
git rev-parse HEAD >> "%LOG%" 2>&1
echo Toolchain: >> "%LOG%"
node --version >> "%LOG%" 2>&1
cargo --version >> "%LOG%" 2>&1
where cl >> "%LOG%" 2>&1
where makensis >> "%LOG%" 2>&1
call npm ci >> "%LOG%" 2>&1
if errorlevel 1 goto :failed
call npm run version:check >> "%LOG%" 2>&1
if errorlevel 1 goto :failed
call npm run architecture:check >> "%LOG%" 2>&1
if errorlevel 1 goto :failed
call npm run typecheck >> "%LOG%" 2>&1
if errorlevel 1 goto :failed
call npm run build --workspace=@awo/desktop-shell >> "%LOG%" 2>&1
if errorlevel 1 goto :failed
echo === BUILD SUCCEEDED === >> "%LOG%"
echo Local build succeeded. See %LOG%
exit /b 0
:failed
set "CODE=%errorlevel%"
echo === BUILD FAILED (%CODE%) === >> "%LOG%"
echo Local build failed with exit code %CODE%. See %LOG%
exit /b %CODE%
