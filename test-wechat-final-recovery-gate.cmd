@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat P7 Final Recovery Gate
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo The farm mini-program will be handled automatically.
echo Do not manually open or close the farm during this gate.
echo.

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-final-recovery-gate.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-final-recovery-gate.ps1"
)

set EXITCODE=%errorlevel%
echo.
if not "%EXITCODE%"=="0" echo P7 final recovery gate exited with code %EXITCODE%.
pause
exit /b %EXITCODE%
