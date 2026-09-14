@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -Verb RunAs -ArgumentList '/c ""%~f0""'"
  exit /b
)

echo Installing FAR2 WebUI one-click update agent...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install-far2-update-agent.ps1"
set "rc=%ERRORLEVEL%"
echo.
if not "%rc%"=="0" (
  echo [FAILED] WebUI one-click update was not enabled. Exit code %rc%.
) else (
  echo [OK] WebUI one-click update is enabled.
  echo Open http://127.0.0.1:3007 and click 升级.
)
pause
exit /b %rc%
