@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Runtime Launch Path Learner
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo This learner does NOT call wx.login.
echo It reads only the exact farm AppId runtime launch path via wx.getLaunchOptionsSync().
echo.

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  set "PSRUN=pwsh.exe"
) else (
  set "PSRUN=powershell.exe"
)

echo PowerShell runner: %PSRUN%
echo.
"%PSRUN%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\learn-wechat-farm-launch-path-runtime.ps1"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" echo Runtime launch path learner exited with code %RC%.
pause
exit /b %RC%
