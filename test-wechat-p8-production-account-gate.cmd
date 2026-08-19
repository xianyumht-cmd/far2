@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat P8 Final Production Account Gate
echo ========================================
echo.
echo IMPORTANT:
echo   Keep FAR2WeChatAgent and QQ Classic Farm open.
echo   FAR2Farm will NOT be restarted by this gate.
echo   This creates/resumes ONE real production WeChat farm account.
echo   After first login, normal FAR2 production routines may run on that account.
echo   The gate normally waits about 6-8 minutes for two scoped refresh cycles.
echo   Raw wx.login Code and Provider token are never printed.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-p8-production-account-gate.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\test-wechat-p8-production-account-gate.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo P8 final production account gate passed.
) else (
  echo P8 final production account gate exited with code %code%.
)
pause
exit /b %code%
