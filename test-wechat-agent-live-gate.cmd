@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat P5 Live Agent Gate
echo ========================================
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-agent-live-gate.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-agent-live-gate.ps1"
)
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" echo P5 live gate exited with code %RC%.
pause
exit /b %RC%
