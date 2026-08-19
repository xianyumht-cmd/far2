@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat Resident Agent Autostart
echo ========================================
echo.
echo Keep the current Resident Agent and QQ Classic Farm open.
echo This installs a future interactive-user logon task only.
echo It will NOT restart FAR2Farm and will NOT start a second Agent now.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install-wechat-resident-agent-autostart.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install-wechat-resident-agent-autostart.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo Resident Agent autostart installation passed.
) else (
  echo Resident Agent autostart installation exited with code %code%.
)
pause
exit /b %code%
