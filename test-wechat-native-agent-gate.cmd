@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat P6 Native WMPF Agent Gate
echo ========================================
echo.

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-native-agent-gate.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-native-agent-gate.ps1"
)

set EXITCODE=%errorlevel%
echo.
if not "%EXITCODE%"=="0" echo P6 native gate exited with code %EXITCODE%.
pause
exit /b %EXITCODE%
