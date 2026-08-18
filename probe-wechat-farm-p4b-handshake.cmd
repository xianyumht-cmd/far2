@echo off
setlocal
set "ROOT=%~dp0"
set "PSRUNNER=%ROOT%scripts\windows\probe-wechat-farm-p4b-handshake.ps1"

echo ========================================
echo FAR2 WeChat Farm P4B Handshake Probe
echo ========================================
echo.
echo This probe does NOT call wx.login.
echo It only observes official farm WebSocket handshake metadata.
echo No Code/openID values, cookies, auth headers, or WebSocket payloads are stored.
echo.

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%PSRUNNER%"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PSRUNNER%"
)

set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo P4B probe exited with code %RC%.
pause
exit /b %RC%
