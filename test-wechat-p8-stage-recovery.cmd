@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat P8 Stage Recovery Gate
echo ========================================
echo.
echo Keep the existing Resident Agent window and QQ Classic Farm open.
echo Production FAR2Farm and QQ workers will NOT be restarted.
echo Validation runs only in the isolated P8 stage.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-p8-stage-recovery.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-p8-stage-recovery.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo P8 isolated stage recovery gate passed.
) else (
  echo P8 isolated stage recovery gate exited with code %code%.
)
pause
exit /b %code%
