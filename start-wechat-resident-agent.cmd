@echo off
setlocal
cd /d "%~dp0"
where pwsh.exe >nul 2>&1
if %errorlevel%==0 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-wechat-resident-agent.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-wechat-resident-agent.ps1"
)
set "RC=%errorlevel%"
pause
exit /b %RC%
