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
        throw "NSSM failed ($LASTEXITCODE): $($Args -join ' ')"
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
    $candidates.Add('D:\project2\lolapisevers\tools\nssm-2.24\win64\nssm.exe')
    $candidates.Add('C:\tools\nssm\win64\nssm.exe')
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'nssm.exe not found. Set NSSM_EXE or place NSSM under tools\nssm-2.24\win64\nssm.exe.'
}

function Read-EnabledQqAccount {
    param([string]$AccountsFile)
    if (-not (Test-Path -LiteralPath $AccountsFile)) {
        throw "Accounts file not found: $AccountsFile"
    }

    $raw = Get-Content -LiteralPath $AccountsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($raw.accounts) {
        $accounts = @($raw.accounts)
    } elseif ($raw -is [System.Array]) {
        $accounts = @($raw)
    } else {
        $accounts = @()
    }

    $enabled = @($accounts | Where-Object {
        $platform = if ($_.platform) { [string]$_.platform } else { 'qq' }
        $mode = if ($_.codeRefreshMode) { [string]$_.codeRefreshMode } else { '' }
        $platform.ToLowerInvariant() -eq 'qq' -and
            $_.codeRefreshEnabled -eq $true -and
            $mode.ToLowerInvariant() -eq 'windows_session'
    })

    if ($enabled.Count -ne 1) {
        throw "Installer requires exactly one enabled windows_session QQ account. Found: $($enabled.Count)."
    }

    $account = $enabled[0]
    $uin = if ($account.uin) { [string]$account.uin } else { [string]$account.qq }
    if ($uin -notmatch '^\d{5,12}$') {
        throw 'Enabled account has no valid QQ/UIN.'
    }
    return @{ Account = $account; Uin = $uin }
}

if (-not (Test-Admin)) {
    throw 'Run install-windows-service.cmd as Administrator.'
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreDir = Join-Path $projectRoot 'core'
$clientJs = Join-Path $coreDir 'client.js'
$accountsFile = Join-Path $coreDir 'data\accounts.json'
$runner = Join-Path $projectRoot 'scripts\windows\run-code-agent-hidden.ps1'
$dataDir = Join-Path $coreDir 'data'

if (-not (Test-Path -LiteralPath $clientJs)) { throw "FAR2 client.js not found: $clientJs" }
if (-not (Test-Path -LiteralPath $runner)) { throw "Agent launcher not found: $runner" }
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

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 500
    Invoke-Nssm -Exe $nssm -Args @('remove', $ServiceName, 'confirm')
    Start-Sleep -Milliseconds 500
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

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$fullTaskName = "$TaskName-$uin"
Get-ScheduledTask -TaskName "$TaskName-*" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue } catch {}
    try { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
}

$taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Uin $uin -Port $AgentPort -TokenEnv $tokenEnv -NodePath `"$nodePath`" -ProjectRoot `"$projectRoot`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $fullTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "FAR2 isolated Code Agent for QQ $uin" -Force | Out-Null

try { Start-ScheduledTask -TaskName $fullTaskName } catch {}
try { Start-Service -Name $ServiceName } catch {}
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$task = Get-ScheduledTask -TaskName $fullTaskName -ErrorAction SilentlyContinue
$svcState = if ($svc) { [string]$svc.Status } else { 'Missing' }
$taskState = if ($task) { [string]$task.State } else { 'Missing' }

Write-Host ''
Write-Host '=== FAR2 background install complete ===' -ForegroundColor Green
Write-Host "NSSM service: $ServiceName state=$svcState startup=Automatic"
Write-Host "Code Agent task: $fullTaskName state=$taskState trigger=AtLogOn Hidden"
Write-Host 'WebUI: http://127.0.0.1:3007'
Write-Host "Refresh interval: $RefreshIntervalMinutes minutes; WS 400 still triggers immediate refresh."
Write-Host 'The Agent remains in the interactive user session; no visible console window is required.'
Write-Host 'If old manual FAR2/Agent consoles are still running, close them now. NSSM/task restart policy will take over automatically.'
