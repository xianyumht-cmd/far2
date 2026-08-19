@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat P8 Production Readiness
echo ========================================
echo.
echo Keep the existing Resident Agent window running.
echo This check is READ ONLY and will NOT restart FAR2Farm.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\check-wechat-production-readiness-v2.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\check-wechat-production-readiness-v2.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo P8 readiness check passed.
) else (
  echo P8 readiness check exited with code %code%.
)
pause
exit /b %code%
