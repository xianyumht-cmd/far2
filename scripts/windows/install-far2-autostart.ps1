param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$TaskName = 'FAR2CodeAgent',
    [int]$AgentPort = 43101,
    [int]$RefreshIntervalMinutes = 60
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Nssm {
    param([string]$Exe, [string[]]$Args)
    & $Exe @Args
    if ($LASTEXITCODE -ne 0) {
        throw "NSSM 执行失败 ($LASTEXITCODE): $($Args -join ' ')"
    }
}

function Find-Nssm {
    param([string]$ProjectRoot)
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:NSSM_EXE) { $candidates.Add($env:NSSM_EXE) }
    try {
        $cmd = Get-Command nssm.exe -ErrorAction Stop
        if ($cmd.Source) { $candidates.Add($cmd.Source) }
    } catch {}
    $candidates.Add((Join-Path $ProjectRoot 'tools\nssm-2.24\win64\nssm.exe'))
    # 复用用户现有 LOLDataSystem 的 NSSM，和接口项目保持同一套运行方式。
    $candidates.Add('D:\project2\lolapisevers\tools\nssm-2.24\win64\nssm.exe')
    $candidates.Add('C:\tools\nssm\win64\nssm.exe')
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw '未找到 nssm.exe。可设置 NSSM_EXE，或把 NSSM 放到 tools\nssm-2.24\win64\nssm.exe。'
}

function Read-EnabledQqAccount {
    param([string]$AccountsFile)
    if (-not (Test-Path -LiteralPath $AccountsFile)) {
        throw "账号文件不存在: $AccountsFile"
    }
    $raw = Get-Content -LiteralPath $AccountsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($raw.accounts) { $accounts = @($raw.accounts) }
    elseif ($raw -is [System.Array]) { $accounts = @($raw) }
    else { $accounts = @() }

    $enabled = @($accounts | Where-Object {
        $platform = if ($_.platform) { [string]$_.platform } else { 'qq' }
        $mode = if ($_.codeRefreshMode) { [string]$_.codeRefreshMode } else { '' }
        $platform.ToLowerInvariant() -eq 'qq' -and $_.codeRefreshEnabled -eq $true -and $mode.ToLowerInvariant() -eq 'windows_session'
    })

    if ($enabled.Count -ne 1) {
        throw "当前安装器要求本 Windows 登录 Session 恰好启用 1 个 windows_session Code 刷新账号，实际为 $($enabled.Count) 个。请在网页/qr:code-manager-config 中只启用当前 QQ 对应账号后重试。"
    }
    $account = $enabled[0]
    $uin = if ($account.uin) { [string]$account.uin } else { [string]$account.qq }
    if ($uin -notmatch '^\d{5,12}$') { throw '启用账号缺少有效 QQ/UIN' }
    return @{ Account = $account; Uin = $uin }
}

if (-not (Test-Admin)) {
    throw '请右键 install-windows-service.cmd 以管理员身份运行。'
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreDir = Join-Path $projectRoot 'core'
$clientJs = Join-Path $coreDir 'client.js'
$accountsFile = Join-Path $coreDir 'data\accounts.json'
$runner = Join-Path $projectRoot 'scripts\windows\run-code-agent-hidden.ps1'
$dataDir = Join-Path $coreDir 'data'

if (-not (Test-Path -LiteralPath $clientJs)) { throw "FAR2 client.js 不存在: $clientJs" }
if (-not (Test-Path -LiteralPath $runner)) { throw "Agent 隐藏启动器不存在: $runner" }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nssm = Find-Nssm -ProjectRoot $projectRoot
$selected = Read-EnabledQqAccount -AccountsFile $accountsFile
$uin = [string]$selected.Uin

$tokenEnv = 'FAR2_CODE_PROVIDER_TOKEN_A'
$token = [Environment]::GetEnvironmentVariable($tokenEnv, 'User')
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes)
    [Environment]::SetEnvironmentVariable($tokenEnv, $token, 'User')
}

$targets = @{}
$targets[$uin] = [ordered]@{
    name = 'runtime_a'
    url = "http://127.0.0.1:$AgentPort"
    tokenEnv = $tokenEnv
}
$targetsJson = $targets | ConvertTo-Json -Compress
$refreshIntervalMs = [Math]::Max(60000, $RefreshIntervalMinutes * 60000)

Write-Host "[FAR2] Project: $projectRoot"
Write-Host "[FAR2] Node: $nodePath"
Write-Host "[FAR2] NSSM: $nssm"
Write-Host "[FAR2] QQ: $($uin.Substring(0,2))****$($uin.Substring($uin.Length-2))"
Write-Host "[FAR2] Agent: 127.0.0.1:$AgentPort"

# 安装/重建主后台服务。主服务可以安全运行在 LocalSystem Session 0；
# 它只负责 WebUI/CodeManager/worker 管理，通过 loopback 调用交互式 Agent。
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 500
    Invoke-Nssm -Exe $nssm -Args @('remove', $ServiceName, 'confirm')
}

Invoke-Nssm -Exe $nssm -Args @('install', $ServiceName, $nodePath)
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppDirectory', $coreDir)
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppParameters', 'client.js')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'DisplayName', 'FAR2 QQ Farm')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'Description', 'FAR2 QQ Farm WebUI / CodeManager background service')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'ObjectName', 'LocalSystem')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppRestartDelay', '5000')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppStdout', (Join-Path $dataDir 'service.stdout.log'))
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppStderr', (Join-Path $dataDir 'service.stderr.log'))
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppRotateFiles', '1')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppRotateOnline', '1')
Invoke-Nssm -Exe $nssm -Args @('set', $ServiceName, 'AppRotateBytes', '5242880')
Invoke-Nssm -Exe $nssm -Args @(
    'set', $ServiceName, 'AppEnvironmentExtra',
    'FARM_CODE_AUTO_REFRESH=1',
    "FARM_CODE_REFRESH_INTERVAL_MS=$refreshIntervalMs",
    'FARM_CODE_PROVIDER_HEALTH_TIMEOUT_MS=20000',
    "FARM_CODE_PROVIDER_TARGETS=$targetsJson",
    "$tokenEnv=$token"
)
Set-Service -Name $ServiceName -StartupType Automatic

# Agent 不能作为 NSSM/LocalSystem 服务运行：Windows 服务位于 Session 0，而 QQ/QQEX
# 在当前用户的交互式 Session。这里用“用户登录时 + 隐藏窗口”的计划任务，
# 从用户视角同样是后台自启，但仍保留真实 Windows SessionId/UIN 防串号边界。
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$fullTaskName = "$TaskName-$uin"
Get-ScheduledTask -TaskName "$TaskName-*" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction Stop } catch {}
}

$taskArgs = @(
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $runner),
    '-Uin', $uin,
    '-Port', [string]$AgentPort,
    '-TokenEnv', $tokenEnv,
    '-NodePath', ('"{0}"' -f $nodePath),
    '-ProjectRoot', ('"{0}"' -f $projectRoot)
) -join ' '
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $fullTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "FAR2 isolated Code Agent for QQ $uin" -Force | Out-Null

# 若当前仍开着之前的手工 Agent，计划任务会因为 43101 被占用而退出；
# 安装完成后关掉旧黑框，再运行一次下方 Start-ScheduledTask 即可。这里先尝试启动。
try { Start-ScheduledTask -TaskName $fullTaskName } catch {}

Start-Service -Name $ServiceName
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName
$task = Get-ScheduledTask -TaskName $fullTaskName
Write-Host ''
Write-Host '=== FAR2 后台安装完成 ===' -ForegroundColor Green
Write-Host "NSSM 服务: $ServiceName  状态=$($svc.Status)  启动=Automatic"
Write-Host "Code Agent: $fullTaskName  状态=$($task.State)  触发=当前用户登录"
Write-Host 'WebUI: http://127.0.0.1:3007'
Write-Host "刷新周期: $RefreshIntervalMinutes 分钟；WS 400 仍会立即触发定向 Code 刷新。"
Write-Host '以后不需要保留两个黑框。电脑登录当前 Windows 用户并让 QQ 在线后，Agent 会在后台运行。'
Write-Host '注意：如果安装时旧 Agent 黑框还在，请现在关掉旧 Agent，然后执行: Start-ScheduledTask -TaskName ' $fullTaskName
