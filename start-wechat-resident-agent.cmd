@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 Windows WeChat Resident Agent
echo ========================================
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-wechat-resident-agent.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-wechat-resident-agent.ps1"
)
set code=%errorlevel%
echo.
if not "%code%"=="0" echo FAR2WeChatAgent exited with code %code%.
pause
exit /b %code%
