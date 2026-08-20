@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo FAR2 Windows WeChat Farm Probe
echo ========================================
echo.
echo 1. Keep desktop WeChat logged in.
echo 2. Open QQ Classic Farm from WeChat once and keep it open.
echo 3. This probe is read-only and does NOT read chats or credentials.
echo.
pause

where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\probe-wechat-farm.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\probe-wechat-farm.ps1"
)

echo.
echo Done. Send the generated wechat-probe-*.json report back for analysis.
pause
endlocal
