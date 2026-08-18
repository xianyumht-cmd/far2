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
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\probe-wechat-farm-p1.ps1"

echo.
if errorlevel 1 (
  echo Probe failed. Please screenshot this window and send it back.
) else (
  echo Done. Send the generated wechat-farm-p1-*.json report back.
)
echo.
pause
endlocal
