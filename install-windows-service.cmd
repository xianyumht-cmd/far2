@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -Verb RunAs -ArgumentList '/c ""%~f0""'"
  exit /b
)

echo Installing FAR2 background service and hidden Code Agent...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install-far2-autostart.ps1"
set RC=%errorlevel%
echo.
if not "%RC%"=="0" (
  echo Install failed. Error code: %RC%
) else (
  echo Install complete. WebUI: http://127.0.0.1:3007
)
pause
exit /b %RC%
