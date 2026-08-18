@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Production Foundation Test
echo ========================================
echo.

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-production-foundation.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-production-foundation.ps1"
)

set "ec=%errorlevel%"
echo.
if not "%ec%"=="0" echo Selftest exited with code %ec%.
pause
exit /b %ec%
