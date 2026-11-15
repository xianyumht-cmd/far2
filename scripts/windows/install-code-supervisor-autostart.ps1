<#
  注册「QQ Code 守护」开机自启（登录时触发，不是定时刷新）

  行为：
    - 登录 Windows 后启动 tools/code-supervisor.js（隐藏窗口）
    - 守护进程自己会先检测 QQ.exe 是否在跑；不在就每 30 秒待命一次
    - 只有 far2 里账号 connected=false 连续两次，才去刷新 Code（无定期刷新）

  用法（管理员 PowerShell）:
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-code-supervisor-autostart.ps1
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-code-supervisor-autostart.ps1 -Uninstall
#>
param(
    [switch]$Uninstall,
    [string]$TaskName = 'FAR2CodeSupervisor',
    [string]$AdminPassword = $env:FAR2_ADMIN_PASS
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$supervisor = Join-Path $projectRoot 'tools\code-supervisor.js'
$logDir = Join-Path $projectRoot 'data'
$logFile = Join-Path $logDir 'code-supervisor.log'

if (-not (Test-Path -LiteralPath $supervisor)) { throw "找不到 $supervisor" }

if ($Uninstall) {
    schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
    Write-Host "已删除计划任务 $TaskName" -ForegroundColor Yellow
    exit 0
}

# 密码来源：显式参数 → 环境变量 → 本机安全存储。任务与 VBS 都不携带密码。
$secretFile = Join-Path $env:USERPROFILE '.far2\admin-pass.txt'
if ([string]::IsNullOrWhiteSpace($AdminPassword) -and (Test-Path -LiteralPath $secretFile)) {
    $AdminPassword = (Get-Content -LiteralPath $secretFile -TotalCount 1).Trim()
}
if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
    throw "未找到管理员密码：请把密码写入 $secretFile（推荐，仅本机可读），或用 -AdminPassword 传入一次。脚本不会把密码写进计划任务或 VBS。"
}
if (-not (Test-Path -LiteralPath $secretFile)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $secretFile) | Out-Null
    Set-Content -LiteralPath $secretFile -Value $AdminPassword -NoNewline -Encoding UTF8
    try { icacls.exe $secretFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null } catch { }
    Write-Host "已把管理员密码写入本机安全存储：$secretFile" -ForegroundColor Green
}

# 优先用项目自带的 Node 20（微信通道用），否则用系统 node
$nodeCandidates = @(
    (Join-Path $projectRoot '.toolchain\node20\node.exe'),
    (Join-Path $projectRoot '.toolchain\node\node.exe')
)
$nodeExe = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $nodeExe) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source }
}
if (-not $nodeExe) { throw '找不到 node.exe' }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 用 vbs 隐藏窗口启动，避免每次登录弹黑框。
# 注意：VBS 里拼命令必须用 Chr(34) 处理引号，否则嵌套引号会被 cmd 吃掉。
$vbs = Join-Path $projectRoot 'data\run-code-supervisor.vbs'
$vbsBody = @"
Set shell = CreateObject("WScript.Shell")
# supervisor 自己从 %USERPROFILE%\.far2\admin-pass.txt 读取密码，VBS 不携带任何凭据
q = Chr(34)
cmd = q & "$nodeExe" & q & " " & q & "$supervisor" & q & " --interval 30 >> " & q & "$logFile" & q & " 2>&1"
shell.Run "cmd /c " & cmd, 0, False
"@
Set-Content -LiteralPath $vbs -Value $vbsBody -Encoding ASCII

$action = "wscript.exe `"$vbs`""
schtasks.exe /Create /TN $TaskName /TR $action /SC ONLOGON /RL HIGHEST /F | Out-Null

Write-Host "已注册开机自启：$TaskName" -ForegroundColor Green
Write-Host "  触发：用户登录时（不是定时刷新）"
Write-Host "  入口：$vbs"
Write-Host "  日志：$logFile"
Write-Host "  守护逻辑：QQ.exe 不在 → 待命；账号掉线连续 2 次 → 才刷新 Code（10 分钟冷却）"
Write-Host ""
Write-Host "立即试跑一次（不等待下次登录）：" -ForegroundColor Cyan
Write-Host "  schtasks.exe /Run /TN $TaskName"
Write-Host "卸载：powershell -ExecutionPolicy Bypass -File scripts\windows\install-code-supervisor-autostart.ps1 -Uninstall"
