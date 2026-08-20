@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat WebUI / Resident Closeout Apply
echo ========================================
echo.
echo IMPORTANT:
echo   Keep FAR2WeChatAgent and QQ Classic Farm open.
echo   This WILL replace only 2 WeChat WebUI source files, rebuild web/dist,
echo   apply the audited semantic client.js enrollment bridge, and restart FAR2Farm once.
echo   The dirty production tree will NOT be reset/checked out/cleaned.
echo   Automatic rollback is attempted on post-mutation failure.
echo.

where pwsh.exe >nul 2>&1
if %errorlevel%==0 (
  set "PS=pwsh.exe"
) else (
  set "PS=powershell.exe"
)

echo PowerShell runner: %PS%
echo.
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\apply-wechat-webui-closeout-v2.ps1"
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
  echo WeChat WebUI closeout controlled apply passed.
) else (
  echo WeChat WebUI closeout controlled apply exited with code %RC%.
)
pause
exit /b %RC%
