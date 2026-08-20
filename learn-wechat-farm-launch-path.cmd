@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Launch Path Learner
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo If QQ Classic Farm is not open, the learner will ask you to open it once.
echo It does not call wx.login or read chat/message/contact data.
echo.

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  set "PSRUN=pwsh.exe"
) else (
  set "PSRUN=powershell.exe"
)

echo PowerShell runner: %PSRUN%
echo.
"%PSRUN%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\learn-wechat-farm-launch-path.ps1"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" echo Launch path learner exited with code %RC%.
pause
exit /b %RC%
