param(
    [string]$TaskName = 'FAR2 WeChat Resident Agent'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateRoot = Join-Path $env:LOCALAPPDATA 'FAR2\wechat-agent'
$runtimeRoot = Join-Path $stateRoot 'runtime'
$depsRoot = Join-Path $stateRoot 'node-deps'
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$expectedAppId = 'wx5306c5978fdb76e4'

$runtimeFiles = @(
    'scripts/windows/start-wechat-resident-agent.ps1',
    'scripts/windows/run-wechat-resident-agent-autostart.ps1',
    'core/scripts/wechat-resident-agent.js',
    'core/src/services/wechat-code-agent.js',
    'core/src/services/wechat-wmpf-resident-capture.js',
    'core/src/services/wechat-wmpf-native-capture.js',
    'core/src/services/windows-runtime-code.js'
)

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-NodePath {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        try {
            $version = (& $node.Source -p "process.versions.node").Trim()
            if ([int]$version.Split('.')[0] -ge 22) { return [string]$node.Source }
        } catch {}
    }

    $serviceKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\FAR2Farm\Parameters'
    if (Test-Path -LiteralPath $serviceKey) {
        $props = Get-ItemProperty -Path $serviceKey -ErrorAction SilentlyContinue
        if ($props -and $props.PSObject.Properties.Name -contains 'Application') {
            $candidate = [string]$props.Application
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                try {
                    $version = (& $candidate -p "process.versions.node").Trim()
                    if ([int]$version.Split('.')[0] -ge 22) { return $candidate }
                } catch {}
            }
        }
    }

    $knownRoots = @(
        (Join-Path $env:TEMP 'FAR2-WeChat-CDP\node22'),
        'D:\project2\napcatplugin'
    )
    foreach ($root in $knownRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $cached = Get-ChildItem -LiteralPath $root -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cached) { continue }
        try {
            $version = (& $cached.FullName -p "process.versions.node").Trim()
            if ([int]$version.Split('.')[0] -ge 22) { return [string]$cached.FullName }
        } catch {}
    }
    throw 'Node.js 22+ was not found.'
}

function Test-AgentHealth {
    param([string]$Token)
    if ([string]::IsNullOrWhiteSpace($Token) -or $Token.Length -lt 24) {
        return [pscustomobject]@{ Available=$false; Reason='provider_token_missing'; AppId='' }
    }
    try {
        $headers = @{ Authorization = "Bearer $Token"; Accept='application/json'; 'Cache-Control'='no-store' }
        $res = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:43201/v1/health' -Headers $headers -TimeoutSec 8
        return [pscustomobject]@{
            Available = ($res.ok -eq $true -and $res.available -eq $true)
            Reason = if ($res.available -eq $true) { 'ok' } else { [string]$res.reason }
            AppId = [string]$res.appId
        }
    } catch {
        return [pscustomobject]@{ Available=$false; Reason='provider_health_failed'; AppId='' }
    }
}

Write-Host ''
Write-Host 'FAR2 WeChat Resident Agent Logon Autostart Installer' -ForegroundColor Cyan
Write-Host '=====================================================' -ForegroundColor Cyan
Write-Host 'This step does NOT restart FAR2Farm and does NOT start a second Agent now.' -ForegroundColor DarkGray
Write-Host 'It installs a self-contained Agent runtime copy and an interactive-user logon task.' -ForegroundColor DarkGray
Write-Host ''

$token = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
$providerUrl = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', 'Machine')
if ([string]::IsNullOrWhiteSpace($providerUrl)) { $providerUrl = 'http://127.0.0.1:43201/' }
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
    throw 'Machine WeChat Provider token is not configured.'
}

$health = Test-AgentHealth -Token $token
if (-not $health.Available -or $health.AppId -ne $expectedAppId) {
    throw "Current Resident Agent is not ready: $($health.Reason). Keep the existing Agent/farm window ready before installing autostart."
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and [string]$existingTask.State -eq 'Running') {
    throw "Scheduled task '$TaskName' is already running. Refusing to replace a live Agent task."
}

$nodePath = Get-NodePath
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

$fileResults = @()
foreach ($rel in $runtimeFiles) {
    $src = Join-Path $projectRoot ($rel -replace '/', '\')
    $dst = Join-Path $runtimeRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "Autostart runtime source missing: $rel" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $sourceHash = Get-FileSha256 -Path $src
    $runtimeHash = Get-FileSha256 -Path $dst
    if ($sourceHash -ne $runtimeHash) { throw "Autostart runtime copy hash mismatch: $rel" }
    $fileResults += [pscustomobject]@{ path=$rel; sha256=$runtimeHash }
}

$runtimeAgent = Join-Path $runtimeRoot 'core\scripts\wechat-resident-agent.js'
$runtimeRunner = Join-Path $runtimeRoot 'scripts\windows\run-wechat-resident-agent-autostart.ps1'

$oldNodePath = $env:NODE_PATH
$depModules = Join-Path $depsRoot 'node_modules'
try {
    if (Test-Path -LiteralPath $depModules) {
        if ([string]::IsNullOrWhiteSpace($env:NODE_PATH)) { $env:NODE_PATH = $depModules }
        else { $env:NODE_PATH = $depModules + [IO.Path]::PathSeparator + $env:NODE_PATH }
    }
    Push-Location -LiteralPath (Join-Path $runtimeRoot 'core')
    try {
        & $nodePath --check $runtimeAgent *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Resident Agent autostart JavaScript syntax check failed.' }
        & $nodePath -e "require('frida');require('ws');require('long');require('protobufjs');require('node-fetch');require('./src/services/wechat-wmpf-resident-capture');require('./src/services/wechat-code-agent');" *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Resident Agent autostart dependency preflight failed.' }
    } finally { Pop-Location }
} finally {
    $env:NODE_PATH = $oldNodePath
}

$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if (-not $pwsh) { $pwsh = Get-Command powershell.exe -ErrorAction SilentlyContinue }
if (-not $pwsh) { throw 'PowerShell executable was not found for Scheduled Task action.' }

$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runtimeRunner`""
$action = New-ScheduledTaskAction -Execute ([string]$pwsh.Source) -Argument $taskArgs -WorkingDirectory $runtimeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'FAR2 Windows WeChat Resident Agent. Runs only in the interactive desktop user session with highest privileges and local failure logging.' -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$registered = ($null -ne $task)
$notStartedNow = ([string]$task.State -ne 'Running')
if (-not $registered) { throw 'Resident Agent logon Scheduled Task registration verification failed.' }
if (-not $notStartedNow) { throw 'Resident Agent autostart task unexpectedly started during install.' }

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-resident-agent-autostart-install-{0}.json" -f $stamp)
$report = [ordered]@{
    version = 2
    phase = 'wechat-resident-agent-interactive-logon-autostart-install'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    runtimeRoot = $runtimeRoot
    task = [ordered]@{
        name = $TaskName
        user = $userId
        registered = $registered
        stateAfterInstall = [string]$task.State
        startedNow = $false
        logonType = 'Interactive'
        runLevel = 'Highest'
        session0 = $false
        localFailureLog = $true
    }
    provider = [ordered]@{
        residentReadyDuringInstall = $health.Available
        appId = $health.AppId
        urlConfigured = -not [string]::IsNullOrWhiteSpace($providerUrl)
        tokenConfigured = ($token.Length -ge 24)
        tokenPrinted = $false
    }
    runtime = [ordered]@{
        node = $nodePath
        syntaxPreflightPassed = $true
        dependencyPreflightPassed = $true
        files = $fileResults
    }
    safety = [ordered]@{
        far2FarmRestarted = $false
        productionAccountsModified = $false
        productionWorktreeModified = $false
        rawCodePrinted = $false
        providerTokenPrinted = $false
        currentManualAgentStopped = $false
        scheduledTaskStartedDuringInstall = $false
    }
    gatePassed = $true
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ("Resident Agent runtime copy: {0}" -f $runtimeRoot)
Write-Host ("Scheduled Task: {0}" -f $TaskName)
Write-Host ("Interactive user: {0}" -f $userId)
Write-Host 'Task registered: True' -ForegroundColor Green
Write-Host 'Task run level: Highest' -ForegroundColor Green
Write-Host 'Local failure logging: True' -ForegroundColor Green
Write-Host 'Task started now: False' -ForegroundColor Green
Write-Host 'Current manual Resident Agent left running: True' -ForegroundColor Green
Write-Host 'FAR2Farm restarted: False' -ForegroundColor Green
Write-Host ''
Write-Host 'At the next Windows logon the Agent will start hidden in this user session.' -ForegroundColor Yellow
Write-Host 'After WeChat is logged in, open QQ Classic Farm once so the exact runtime can bootstrap.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Report path:'
Write-Host $reportPath
Write-Host ''
Write-Host 'Resident Agent logon autostart installation PASSED.' -ForegroundColor Green
