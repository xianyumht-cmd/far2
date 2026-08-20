@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat Production Account Name Repair
echo ========================================
echo.
echo IMPORTANT:
echo   Keep FAR2WeChatAgent and QQ Classic Farm open.
echo   FAR2Farm will NOT be restarted.
echo   Only the WeChat account display name is changed.
echo   The script will ask for the FAR2 admin password; it is not printed or stored.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\fix-wechat-production-account-name.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\fix-wechat-production-account-name.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo WeChat production account name repair passed.
) else (
  echo WeChat production account name repair exited with code %code%.
)
pause
exit /b %code%
