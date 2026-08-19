@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo FAR2 WeChat WebUI / Legacy Closeout Audit
echo ========================================
echo.
echo Keep FAR2WeChatAgent and QQ Classic Farm open.
echo This audit is READ ONLY and will NOT restart FAR2Farm.
echo It builds only an isolated WebUI/client candidate.
echo.
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  echo PowerShell runner: pwsh.exe
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\audit-wechat-webui-closeout.ps1"
) else (
  echo PowerShell runner: powershell.exe
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\audit-wechat-webui-closeout.ps1"
)
set code=%errorlevel%
echo.
if "%code%"=="0" (
  echo WeChat WebUI closeout audit passed.
) else (
  echo WeChat WebUI closeout audit exited with code %code%.
)
pause
exit /b %code%
