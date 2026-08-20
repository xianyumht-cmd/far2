@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat P7R Resident Recovery Gate
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo The script will close only the QQ Classic Farm window if it is already open.
echo After FAR2 arms the resident WMPF transport, open the farm ONCE manually.
echo After that point the ws_400 recovery test requires no manual action.
echo.

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  set "PSRUN=pwsh.exe"
) else (
  set "PSRUN=powershell.exe"
)

echo PowerShell runner: %PSRUN%
echo.
"%PSRUN%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-resident-recovery-gate.ps1"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" echo P7R resident recovery gate exited with code %RC%.
pause
exit /b %RC%
