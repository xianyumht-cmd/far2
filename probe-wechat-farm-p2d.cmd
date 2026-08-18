@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Farm P2D WMPF Identifier Probe
echo ========================================
echo.
echo Keep desktop WeChat logged in and QQ Classic Farm OPEN.
echo This probe outputs only the wmpf-appid identifier value.
echo.

where pwsh.exe >nul 2>&1
if %ERRORLEVEL%==0 (
  set "FAR2_PS=pwsh.exe"
) else (
  set "FAR2_PS=powershell.exe"
)

echo PowerShell runner: %FAR2_PS%
echo.
"%FAR2_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\probe-wechat-farm-p2d.ps1"

set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Probe failed. Please send a screenshot of this window.
) else (
  echo Done. Send the generated wechat-farm-p2d-*.json report back.
)
echo.
pause
exit /b %RC%
