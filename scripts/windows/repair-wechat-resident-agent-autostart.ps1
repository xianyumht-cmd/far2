param(
    [string]$TaskName = 'FAR2 WeChat Resident Agent'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
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
    'core/scripts/wechat-isolated-code-agent.js',
    'core/src/services/wechat-code-agent.js',
    'core/src/services/wechat-wmpf-resident-capture.js',
    'core/src/services/wechat-wmpf-native-capture.js',
    'core/src/services/windows-runtime-code.js'
)

function Get-Prop {
    param([object]$Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    return $prop.Value
}

function Get-NodePath {
    $serviceKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\FAR2Farm\Parameters'
    if (Test-Path -LiteralPath $serviceKey) {
        $props = Get-ItemProperty -Path $serviceKey -ErrorAction SilentlyContinue
        $candidate = [string](Get-Prop $props 'Application' '')
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            try {
                $version = (& $candidate -p "process.versions.node").Trim()
                if ([int]$version.Split('.')[0] -ge 22) { return $candidate }
            } catch {}
        }
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($node) {
        try {
            $version = (& $node.Source -p "process.versions.node").Trim()
            if ([int]$version.Split('.')[0] -ge 22) { return [string]$node.Source }
        } catch {}
    }
    $knownRoots = @((Join-Path $env:TEMP 'FAR2-WeChat-CDP\node22'), 'D:\project2\napcatplugin')
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

function Test-AgentEndpoint {
    param([string]$Token)
    try {
        $headers = @{ Authorization = "Bearer $Token"; Accept='application/json'; 'Cache-Control'='no-store' }
        $res = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:43201/v1/health' -Headers $headers -TimeoutSec 4
        return [pscustomobject]@{
            Reachable = $true
            Available = ($res.ok -eq $true -and $res.available -eq $true)
            Reason = [string](Get-Prop $res 'reason' 'ok')
            AppId = [string](Get-Prop $res 'appId' '')
        }
    } catch {
        return [pscustomobject]@{ Reachable=$false; Available=$false; Reason='ECONNREFUSED'; AppId='' }
    }
}

function Set-WeChatTaskKeepalive {
    param([string]$Name)

    $xmlText = Export-ScheduledTask -TaskName $Name
    [xml]$xml = $xmlText
    $nsUri = [string]$xml.DocumentElement.NamespaceURI
    $nsm = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
    $nsm.AddNamespace('t', $nsUri)

    $settings = $xml.SelectSingleNode('/t:Task/t:Settings', $nsm)
    if (-not $settings) { throw 'Task Settings node not found.' }

    $multiple = $settings.SelectSingleNode('t:MultipleInstancesPolicy', $nsm)
    $startWhenAvailable = $settings.SelectSingleNode('t:StartWhenAvailable', $nsm)
    $executionLimit = $settings.SelectSingleNode('t:ExecutionTimeLimit', $nsm)

    if (-not $multiple) { throw 'Task MultipleInstancesPolicy node not found.' }
    if (-not $startWhenAvailable) { throw 'Task StartWhenAvailable node not found.' }
    if (-not $executionLimit) { throw 'Task ExecutionTimeLimit node not found.' }

    $multiple.InnerText = 'IgnoreNew'
    $startWhenAvailable.InnerText = 'true'
    $executionLimit.InnerText = 'PT0S'

    $restart = $settings.SelectSingleNode('t:RestartOnFailure', $nsm)
    if (-not $restart) {
        $restart = $xml.CreateElement('RestartOnFailure', $nsUri)
        [void]$settings.InsertBefore($restart, $multiple)
    }

    $interval = $restart.SelectSingleNode('t:Interval', $nsm)
    if (-not $interval) {
        $interval = $xml.CreateElement('Interval', $nsUri)
        [void]$restart.AppendChild($interval)
    }
    $interval.InnerText = 'PT1M'

    $count = $restart.SelectSingleNode('t:Count', $nsm)
    if (-not $count) {
        $count = $xml.CreateElement('Count', $nsUri)
        [void]$restart.AppendChild($count)
    }
    $count.InnerText = '999'

    Register-ScheduledTask -TaskName $Name -Xml $xml.OuterXml -Force | Out-Null
}
Write-Host ''
Write-Host 'FAR2 WeChat Resident Agent Reboot/Autostart Repair' -ForegroundColor Cyan
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host 'This repairs only the interactive logon Agent task/runtime. FAR2Farm is NOT restarted.' -ForegroundColor DarkGray
Write-Host 'No wx.login Code or Provider token is printed.' -ForegroundColor DarkGray
Write-Host ''

$principalNow = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principalNow.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated Administrator PowerShell.'
}

$token = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) { throw 'Machine Provider token is missing.' }

$nodePath = Get-NodePath
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
foreach ($rel in $runtimeFiles) {
    $src = Join-Path $projectRoot ($rel -replace '/', '\')
    $dst = Join-Path $runtimeRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "Runtime source missing: $rel" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
}

$depModules = Join-Path $depsRoot 'node_modules'
if (-not (Test-Path -LiteralPath $depModules -PathType Container)) { throw "Resident Agent dependencies missing: $depModules" }
$oldNodePath = $env:NODE_PATH
try {
    $env:NODE_PATH = if ([string]::IsNullOrWhiteSpace($oldNodePath)) { $depModules } else { $depModules + [IO.Path]::PathSeparator + $oldNodePath }
    Push-Location -LiteralPath (Join-Path $runtimeRoot 'core')
    try {
        $agentScript = Join-Path $runtimeRoot 'core\scripts\wechat-isolated-code-agent.js'
        & $nodePath --check $agentScript *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Resident Agent syntax preflight failed.' }
        & $nodePath -e "require('frida');require('ws');require('long');require('protobufjs');require('node-fetch');require('./src/services/wechat-wmpf-resident-capture');" *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Resident Agent dependency preflight failed.' }
    } finally { Pop-Location }
} finally { $env:NODE_PATH = $oldNodePath }

$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if (-not $pwsh) { $pwsh = Get-Command powershell.exe -ErrorAction SilentlyContinue }
if (-not $pwsh) { throw 'PowerShell executable not found.' }
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$runtimeRunner = Join-Path $runtimeRoot 'scripts\windows\run-wechat-resident-agent-autostart.ps1'
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runtimeRunner`""
$action = New-ScheduledTaskAction -Execute ([string]$pwsh.Source) -Argument $taskArgs -WorkingDirectory $runtimeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'FAR2 Windows WeChat Resident Agent. Interactive desktop task, highest privileges, hidden, with local failure log.' -Force | Out-Null
Set-WeChatTaskKeepalive -Name $TaskName

$before = Test-AgentEndpoint -Token $token
$startedNow = $false
if (-not $before.Reachable) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $startedNow = $true
}

$deadline = (Get-Date).AddSeconds(30)
$after = $before
while ((Get-Date) -lt $deadline) {
    $after = Test-AgentEndpoint -Token $token
    if ($after.Reachable) { break }
    Start-Sleep -Seconds 2
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
$latestLog = Get-ChildItem -LiteralPath (Join-Path $stateRoot 'logs') -Filter 'resident-agent-autostart-*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-resident-agent-autostart-repair-{0}.json" -f $stamp)
$report = [ordered]@{
    version = 1
    phase = 'wechat-resident-agent-autostart-repair'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    task = [ordered]@{
        name = $TaskName
        user = $userId
        state = [string]$task.State
        runLevel = 'Highest'
        logonType = 'Interactive'
        startedNow = $startedNow
        lastTaskResult = [int64]$taskInfo.LastTaskResult
    }
    endpoint = [ordered]@{
        reachableBefore = $before.Reachable
        reachableAfter = $after.Reachable
        residentAvailableAfter = $after.Available
        reasonAfter = $after.Reason
        appIdAfter = $after.AppId
    }
    runtime = [ordered]@{
        root = $runtimeRoot
        logPath = if ($latestLog) { [string]$latestLog.FullName } else { '' }
        syntaxPassed = $true
        dependenciesPassed = $true
    }
    safety = [ordered]@{
        far2FarmRestarted = $false
        productionAccountsModified = $false
        rawCodePrinted = $false
        providerTokenPrinted = $false
    }
    gatePassed = $after.Reachable
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ("Scheduled Task run level: Highest") -ForegroundColor Green
Write-Host ("Agent endpoint reachable: {0}" -f $after.Reachable) -ForegroundColor $(if ($after.Reachable) { 'Green' } else { 'Red' })
Write-Host ("Resident runtime ready: {0} ({1})" -f $after.Available, $after.Reason)
Write-Host ("Task state / result: {0} / {1}" -f $task.State, $taskInfo.LastTaskResult)
if ($latestLog) { Write-Host ("Autostart log: {0}" -f $latestLog.FullName) }
Write-Host ("Report: {0}" -f $reportPath)
Write-Host ''

if (-not $after.Reachable) {
    throw 'Resident Agent task still did not open 127.0.0.1:43201. Send the report + autostart log; FAR2Farm was not restarted.'
}
if (-not $after.Available) {
    Write-Host 'Agent process is now running. Open/reopen QQ Classic Farm once so the exact farm runtime can attach.' -ForegroundColor Yellow
} else {
    Write-Host 'Resident Agent autostart repair PASSED and exact farm runtime is ready.' -ForegroundColor Green
}
