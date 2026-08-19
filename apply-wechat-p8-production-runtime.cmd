@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat P8 Controlled Production Apply
echo ========================================
echo.
echo IMPORTANT:
echo   Keep FAR2WeChatAgent and QQ Classic Farm open.
echo   This step WILL restart FAR2Farm once after audited files/env are applied.
echo   Production accounts/data are not edited.
echo   A failed apply triggers automatic rollback.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\apply-wechat-p8-production-runtime.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\apply-wechat-p8-production-runtime.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo P8 controlled production apply passed.
) else (
  echo P8 controlled production apply exited with code %code%.
)
pause
exit /b %code%
