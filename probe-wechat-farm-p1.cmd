@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Farm P1 Diff Probe
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo Close ONLY the farm mini-program window before starting.
echo The script will ask you to open the farm once during capture.
echo It will NOT open Explorer automatically.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\probe-wechat-farm-p1.ps1"

set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Probe failed. Please send a screenshot of this window.
) else (
  echo Done. Send the generated wechat-farm-p1-*.json report back.
)
echo.
pause
exit /b %RC%
