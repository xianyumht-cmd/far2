@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Farm P3B wx.login Proof
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo CLOSE only the QQ Classic Farm mini-program window before continuing.
echo P3B identifies the farm AppId first, then calls wx.login exactly once.
echo The raw login Code is NOT printed and is NOT written to the JSON report.
echo.

where pwsh.exe >nul 2>&1
if %ERRORLEVEL%==0 (
  set "FAR2_PS=pwsh.exe"
) else (
  set "FAR2_PS=powershell.exe"
)

echo PowerShell runner: %FAR2_PS%
echo.
"%FAR2_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\probe-wechat-farm-p3b-login.ps1"

set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo P3B probe failed. Send the last lines of this window back.
) else (
  echo P3B probe completed. Send the generated wechat-farm-p3b-login-*.json report back.
)
echo.
pause
exit /b %RC%
