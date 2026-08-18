@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Farm P3 CDP Probe
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo CLOSE only the QQ Classic Farm mini-program window before continuing.
echo This probe will start a temporary isolated WMPF debugger, then ask you to reopen the farm.
echo It only checks whether the farm JS context exposes wx and wx.login.
echo It does NOT call wx.login yet and does NOT capture Code/Token/Cookie.
echo.

where pwsh.exe >nul 2>&1
if %ERRORLEVEL%==0 (
  set "FAR2_PS=pwsh.exe"
) else (
  set "FAR2_PS=powershell.exe"
)

echo PowerShell runner: %FAR2_PS%
echo.
"%FAR2_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\run-wechat-farm-p3-cdp.ps1"

set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo P3 probe failed. Send the last lines of this window back.
) else (
  echo P3 probe completed. Send the generated wechat-farm-p3-cdp-*.json report back.
)
echo.
pause
exit /b %RC%
