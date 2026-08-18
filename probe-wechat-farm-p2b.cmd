@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 WeChat Farm P2B Target AppId Probe
echo ========================================
echo.
echo Keep desktop WeChat logged in.
echo Keep QQ Classic Farm OPEN.
echo This probe stores only target-AppId match status and local listener process metadata.
echo.

where pwsh.exe >nul 2>&1
if %ERRORLEVEL%==0 (
  set "FAR2_PS=pwsh.exe"
) else (
  set "FAR2_PS=powershell.exe"
)

echo PowerShell runner: %FAR2_PS%
echo.
"%FAR2_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\probe-wechat-farm-p2b.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Probe failed. Please send the last error lines.
) else (
  echo Done. Send the generated wechat-farm-p2b-*.json report back.
)
echo.
pause
exit /b %RC%
