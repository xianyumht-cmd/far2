@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat On-Invalid Refresh Policy Apply
echo ========================================
echo.
echo This disables periodic 3-minute WeChat Code refresh.
echo WeChat Code will refresh automatically only after invalid-session events.
echo FAR2Farm WILL restart once if preflight passes.
echo.
where pwsh.exe >nul 2>&1
if %errorlevel%==0 (
  set "PS=pwsh.exe"
) else (
  set "PS=powershell.exe"
)
echo PowerShell runner: %PS%
echo.
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\apply-wechat-on-invalid-refresh-policy-v2.ps1"
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
  echo WeChat on-invalid refresh policy apply passed.
) else (
  echo WeChat on-invalid refresh policy apply exited with code %RC%.
)
pause
exit /b %RC%
