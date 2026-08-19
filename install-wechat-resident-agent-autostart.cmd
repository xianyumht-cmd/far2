@echo off
setlocal
cd /d "%~dp0"
where pwsh.exe >nul 2>&1
if %errorlevel%==0 (
  set "PS=pwsh.exe"
) else (
  set "PS=powershell.exe"
)
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install-wechat-resident-agent-autostart.ps1"
set "RC=%errorlevel%"
pause
exit /b %RC%
