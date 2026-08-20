@echo off
setlocal
set "SCRIPT=%~dp0scripts\windows\probe-wechat-farm-p4-e2e.ps1"

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  set "PS=pwsh.exe"
) else (
  set "PS=powershell.exe"
)

echo FAR2 WeChat P4 E2E launcher
echo Runner: %PS%
echo.

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo P4 probe exited with code %RC%.
pause
exit /b %RC%
