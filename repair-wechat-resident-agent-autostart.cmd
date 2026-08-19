@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat Resident Agent Autostart Repair
echo ========================================
echo.
echo This repairs the Windows logon Resident Agent task only.
echo FAR2Farm will NOT be restarted.
echo.
where pwsh.exe >nul 2>&1
if %errorlevel%==0 (
  set "PS=pwsh.exe"
) else (
  set "PS=powershell.exe"
)
echo PowerShell runner: %PS%
echo.
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\repair-wechat-resident-agent-autostart.ps1"
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
  echo Resident Agent autostart repair completed.
) else (
  echo Resident Agent autostart repair exited with code %RC%.
)
pause
exit /b %RC%
