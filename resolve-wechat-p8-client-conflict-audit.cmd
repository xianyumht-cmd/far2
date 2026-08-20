@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat P8 client.js Resolution Audit
echo ========================================
echo.
echo Keep the Resident Agent window running.
echo This is READ ONLY and will NOT restart FAR2Farm.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\resolve-wechat-p8-client-conflict-audit.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\resolve-wechat-p8-client-conflict-audit.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo P8 client conflict resolution audit passed.
) else (
  echo P8 client conflict resolution audit exited with code %code%.
)
pause
exit /b %code%
