@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat P8 Isolated Stage
echo ========================================
echo.
echo Keep the Resident Agent window running.
echo Production FAR2Farm will NOT be restarted.
echo Production worktree/data will NOT be modified.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\prepare-wechat-p8-stage.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\prepare-wechat-p8-stage.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo P8 isolated stage preparation passed.
) else (
  echo P8 isolated stage preparation exited with code %code%.
)
pause
exit /b %code%
