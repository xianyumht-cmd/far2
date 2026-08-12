param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$TaskName = 'FAR2CodeAgent',
    [int]$AgentPort = 0,
    [string]$Uin = '',
    [string]$TokenEnv = '',
    [int]$RefreshIntervalMinutes = 60
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Nssm {
    param([string]$Exe, [string[]]$NssmArgs)
    & $Exe @NssmArgs
    if ($LASTEXITCODE -ne 0) {
        throw "NSSM failed ($LASTEXITCODE): $($NssmArgs -join ' ')"
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
    $candidates.Add('D:\Program Files\nssm-2.24\nssm.exe')
    $candidates.Add('D:\project2\lolapisevers\tools\nssm-2.24\win64\nssm.exe')
    $candidates.Add('C:\tools\nssm\win64\nssm.exe')
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'nssm.exe not found. Set NSSM_EXE or place NSSM under tools\nssm-2.24\win64\nssm.exe.'
}

function Mask-Uin {
    param([string]$Value)
    $text = [string]$Value
    if ($text -notmatch '^\d{5,12}$') { return '' }
    if ($text.Length -le 4) { return '****' }
    return $text.Substring(0, 2) + '****' + $text.Substring($text.Length - 2)
}

function Read-EnabledQqAccounts {
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

    $enabled = New-Object System.Collections.ArrayList
    foreach ($account in $accounts) {
        $platform = if ($account.platform) { [string]$account.platform } else { 'qq' }
        $mode = if ($account.codeRefreshMode) { [string]$account.codeRefreshMode } else { '' }
        if ($platform.ToLowerInvariant() -ne 'qq') { continue }
        if ($account.codeRefreshEnabled -ne $true) { continue }
        if ($mode.ToLowerInvariant() -ne 'windows_session') { continue }

        $qq = if ($account.uin) { [string]$account.uin } else { [string]$account.qq }
        if ($qq -notmatch '^\d{5,12}$') {
            throw "Enabled account '$($account.id)' has no valid QQ/UIN."
        }
        [void]$enabled.Add([pscustomobject]@{
            Account = $account
            Uin = $qq
        })
    }
    return @($enabled)
}

function Get-CurrentSessionAnnotatedUins {
    $selfSession = (Get-Process -Id $PID -ErrorAction Stop).SessionId
    $found = New-Object 'System.Collections.Generic.HashSet[string]'
    try {
        $rows = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction Stop | Where-Object {
            [int]$_.SessionId -eq [int]$selfSession
        })
        foreach ($row in $rows) {
            $cmd = [string]$row.CommandLine
            $matches = [regex]::Matches($cmd, '--annotation=uin=(\d{5,12})', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            foreach ($match in $matches) {
                if ($match.Groups.Count -gt 1) {
                    [void]$found.Add([string]$match.Groups[1].Value)
                }
            }
        }
    } catch {}
    return @($found | ForEach-Object { $_ })
}

function Select-EnabledQqAccount {
    param(
        [object[]]$Enabled,
        [string]$RequestedUin
    )

    $requested = [string]$RequestedUin
    if ($requested) {
        if ($requested -notmatch '^\d{5,12}$') {
            throw '-Uin must be a valid QQ UIN.'
        }
        $matches = @($Enabled | Where-Object { [string]$_.Uin -eq $requested })
        if ($matches.Count -ne 1) {
            throw "QQ $requested is not an enabled windows_session account in core\data\accounts.json."
        }
        return $matches[0]
    }

    if ($Enabled.Count -eq 1) {
        return $Enabled[0]
    }
    if ($Enabled.Count -eq 0) {
        throw 'No enabled windows_session QQ account found in core\data\accounts.json.'
    }

    $observed = @(Get-CurrentSessionAnnotatedUins)
    $matches = @($Enabled | Where-Object { $observed -contains [string]$_.Uin })
    if ($matches.Count -eq 1) {
        return $matches[0]
    }

    $maskedObserved = @($observed | ForEach-Object { Mask-Uin -Value $_ }) -join ','
    if (-not $maskedObserved) { $maskedObserved = '-' }
    throw "Multiple windows_session QQ accounts are enabled, but this Windows Session could not be mapped uniquely (observed=$maskedObserved). Open QQ Farm once in this Windows user or run install-far2-autostart.ps1 with -Uin <QQ>."
}

function Get-NssmEnvironmentEntries {
    param([string]$Name)
    $parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (-not (Test-Path -LiteralPath $parametersKey)) { return @() }
    try {
        return @((Get-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -ErrorAction Stop).AppEnvironmentExtra)
    } catch {
        return @()
    }
}

function Convert-EnvironmentEntriesToMap {
    param([string[]]$Entries)
    $map = [ordered]@{}
    foreach ($entry in @($Entries)) {
        $text = [string]$entry
        $idx = $text.IndexOf('=')
        if ($idx -le 0) { continue }
        $name = $text.Substring(0, $idx)
        $value = $text.Substring($idx + 1)
        $map[$name] = $value
    }
    return $map
}

function Convert-EnvironmentMapToEntries {
    param($Map)
    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Map.Keys) {
        $entries.Add("$key=$($Map[$key])")
    }
    return @($entries)
}

function Read-ProviderTargets {
    param($EnvironmentMap)
    $raw = ''
    if ($EnvironmentMap.Contains('FARM_CODE_PROVIDER_TARGETS_B64')) {
        $encoded = [string]$EnvironmentMap['FARM_CODE_PROVIDER_TARGETS_B64']
        if ($encoded) {
            try {
                $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
            } catch {
                throw 'Existing FARM_CODE_PROVIDER_TARGETS_B64 is invalid; refusing to overwrite it.'
            }
        }
    } elseif ($EnvironmentMap.Contains('FARM_CODE_PROVIDER_TARGETS')) {
        $raw = [string]$EnvironmentMap['FARM_CODE_PROVIDER_TARGETS']
    }

    $targets = [ordered]@{}
    if (-not $raw) { return $targets }

    try {
        $decoded = $raw | ConvertFrom-Json
    } catch {
        throw 'Existing Provider targets JSON is invalid; refusing to overwrite it.'
    }
    if (-not $decoded) { return $targets }

    foreach ($prop in @($decoded.PSObject.Properties)) {
        $key = [string]$prop.Name
        if ($key -notmatch '^\d{5,12}$') {
            throw "Existing Provider target has invalid QQ UIN: $key"
        }
        $spec = $prop.Value
        if ($spec -is [string]) {
            $targets[$key] = [ordered]@{
                name = 'isolated_runtime'
                url = [string]$spec
                tokenEnv = ''
            }
        } else {
            $targets[$key] = [ordered]@{
                name = if ($spec.name) { [string]$spec.name } else { 'isolated_runtime' }
                url = if ($spec.url) { [string]$spec.url } else { '' }
                tokenEnv = if ($spec.tokenEnv) { [string]$spec.tokenEnv } else { '' }
                token = if ($spec.token) { [string]$spec.token } else { '' }
            }
        }
    }
    return $targets
}

function Get-PortFromTarget {
    param($Target)
    if (-not $Target) { return 0 }
    try {
        $uri = [Uri]([string]$Target['url'])
        if ($uri.Host -notin @('127.0.0.1', 'localhost', '::1')) { return 0 }
        return [int]$uri.Port
    } catch {
        return 0
    }
}

function Select-AgentPort {
    param(
        [int]$RequestedPort,
        [string]$SelectedUin,
        $Targets
    )

    $usedByOther = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($key in $Targets.Keys) {
        if ([string]$key -eq $SelectedUin) { continue }
        $port = Get-PortFromTarget -Target $Targets[$key]
        if ($port -gt 0) { [void]$usedByOther.Add($port) }
    }

    if ($RequestedPort -gt 0) {
        if ($RequestedPort -gt 65535) { throw '-AgentPort must be between 1 and 65535.' }
        if ($usedByOther.Contains($RequestedPort)) {
            throw "Agent port $RequestedPort is already assigned to another QQ Provider target."
        }
        return $RequestedPort
    }

    if ($Targets.Contains($SelectedUin)) {
        $existingUrl = [string]$Targets[$SelectedUin]['url']
        $existing = Get-PortFromTarget -Target $Targets[$SelectedUin]
        if ($existing -gt 0 -and -not $usedByOther.Contains($existing)) {
            return $existing
        }
        if ($existingUrl) {
            throw "QQ $SelectedUin already has a non-loopback or invalid Provider URL. Pass -AgentPort explicitly only if you intend to replace that target with a local Windows Session Agent."
        }
    }

    for ($candidate = 43101; $candidate -le 43199; $candidate++) {
        if (-not $usedByOther.Contains($candidate)) {
            return $candidate
        }
    }
    throw 'No free FAR2 Code Agent port available in 43101-43199.'
}

function Select-TokenEnvironmentName {
    param(
        [string]$RequestedName,
        [string]$SelectedUin,
        $Targets
    )

    $used = @()
    foreach ($key in $Targets.Keys) {
        if ([string]$key -eq $SelectedUin) { continue }
        $other = [string]$Targets[$key]['tokenEnv']
        if ($other -and $used -notcontains $other) { $used += $other }
    }

    $name = [string]$RequestedName
    if (-not $name -and $Targets.Contains($SelectedUin)) {
        $name = [string]$Targets[$SelectedUin]['tokenEnv']
    }
    if (-not $name) {
        foreach ($suffix in [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
            $candidate = "FAR2_CODE_PROVIDER_TOKEN_$suffix"
            if ($used -notcontains $candidate) {
                $name = $candidate
                break
            }
        }
    }
    if (-not $name) {
        for ($index = 1; $index -le 99; $index++) {
            $candidate = ('FAR2_CODE_PROVIDER_TOKEN_{0:D2}' -f $index)
            if ($used -notcontains $candidate) {
                $name = $candidate
                break
            }
        }
    }
    if (-not $name) {
        throw 'No free FAR2 provider token environment name is available.'
    }
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "Invalid token environment variable name: $name"
    }
    if ($used -contains $name) {
        throw "Token environment variable $name is already assigned to another QQ target."
    }
    return $name
}

function Get-OrCreateProviderToken {
    param(
        [string]$Name,
        $EnvironmentMap
    )

    $token = [Environment]::GetEnvironmentVariable($Name, 'User')
    if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
        $serviceToken = if ($EnvironmentMap.Contains($Name)) { [string]$EnvironmentMap[$Name] } else { '' }
        if (-not [string]::IsNullOrWhiteSpace($serviceToken) -and $serviceToken.Length -ge 24) {
            $token = $serviceToken
            [Environment]::SetEnvironmentVariable($Name, $token, 'User')
        } else {
            $bytes = New-Object byte[] 32
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
            $token = [Convert]::ToBase64String($bytes)
            [Environment]::SetEnvironmentVariable($Name, $token, 'User')
        }
    }
    return $token
}

function Set-NssmEnvironmentBlock {
    param(
        [string]$Name,
        [string[]]$Entries
    )
    $parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (-not (Test-Path -LiteralPath $parametersKey)) {
        throw "NSSM service parameters key not found: $parametersKey"
    }

    New-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -PropertyType MultiString -Value $Entries -Force | Out-Null

    $written = @((Get-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -ErrorAction Stop).AppEnvironmentExtra)
    foreach ($entry in $Entries) {
        if ($written -notcontains $entry) {
            throw "NSSM environment verification failed for: $($entry.Split('=')[0])"
        }
    }
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
$enabledAccounts = @(Read-EnabledQqAccounts -AccountsFile $accountsFile)
$selected = Select-EnabledQqAccount -Enabled $enabledAccounts -RequestedUin $Uin
$uin = [string]$selected.Uin

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$existingEntries = if ($existingService) { @(Get-NssmEnvironmentEntries -Name $ServiceName) } else { @() }
$environmentMap = Convert-EnvironmentEntriesToMap -Entries $existingEntries
$targets = Read-ProviderTargets -EnvironmentMap $environmentMap

$resolvedPort = Select-AgentPort -RequestedPort $AgentPort -SelectedUin $uin -Targets $targets
$resolvedTokenEnv = Select-TokenEnvironmentName -RequestedName $TokenEnv -SelectedUin $uin -Targets $targets
$token = Get-OrCreateProviderToken -Name $resolvedTokenEnv -EnvironmentMap $environmentMap

$existingTargetName = ''
if ($targets.Contains($uin)) {
    $existingTargetName = [string]$targets[$uin]['name']
}
$targetName = if ($existingTargetName) { $existingTargetName } else { "runtime_$resolvedPort" }
$targets[$uin] = [ordered]@{
    name = $targetName
    url = "http://127.0.0.1:$resolvedPort"
    tokenEnv = $resolvedTokenEnv
}

$targetsJson = $targets | ConvertTo-Json -Compress -Depth 6
$targetsB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($targetsJson))

# Production mode is event-driven: WS400 / kickout / manual requests refresh immediately,
# while healthy accounts are not proactively re-login every hour. CodeManager currently
# expects an interval, so keep its passive scheduled horizon far in the future.
$eventOnlyHorizonMs = [int64]315360000000
$environmentMap['FARM_CODE_AUTO_REFRESH'] = '1'
$environmentMap['FARM_CODE_SCHEDULED_REFRESH'] = '0'
$environmentMap['FARM_CODE_REFRESH_INTERVAL_MS'] = [string]$eventOnlyHorizonMs
$environmentMap['FARM_CODE_PROVIDER_HEALTH_TIMEOUT_MS'] = '20000'
$environmentMap['FARM_CODE_PROVIDER_TARGETS_B64'] = $targetsB64
if ($environmentMap.Contains('FARM_CODE_PROVIDER_TARGETS')) {
    $environmentMap.Remove('FARM_CODE_PROVIDER_TARGETS')
}
$environmentMap[$resolvedTokenEnv] = $token

$serviceEnvironment = @(Convert-EnvironmentMapToEntries -Map $environmentMap)

Write-Host "[FAR2] Project: $projectRoot"
Write-Host "[FAR2] Node: $nodePath"
Write-Host "[FAR2] NSSM: $nssm"
Write-Host "[FAR2] Windows user: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Write-Host "[FAR2] QQ: $(Mask-Uin -Value $uin)"
Write-Host "[FAR2] Agent: 127.0.0.1:$resolvedPort"
Write-Host "[FAR2] Provider targets after merge: $($targets.Count)"
Write-Host '[FAR2] Refresh mode: event-only (WS400/kickout/manual); healthy periodic refresh disabled'

if ($existingService) {
    try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 500
} else {
    Invoke-Nssm -Exe $nssm -NssmArgs @('install', $ServiceName, $nodePath)
}

Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'Application', $nodePath)
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppDirectory', $coreDir)
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppParameters', 'client.js')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'DisplayName', 'FAR2 QQ Farm')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'Description', 'FAR2 QQ Farm WebUI / CodeManager background service')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'ObjectName', 'LocalSystem')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppRestartDelay', '5000')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppStdout', (Join-Path $dataDir 'service.stdout.log'))
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppStderr', (Join-Path $dataDir 'service.stderr.log'))
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppRotateFiles', '1')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppRotateOnline', '1')
Invoke-Nssm -Exe $nssm -NssmArgs @('set', $ServiceName, 'AppRotateBytes', '5242880')

# NSSM AppEnvironmentExtra is a REG_MULTI_SZ. Writing it directly avoids shell/CLI
# argument handling differences in old NSSM/PowerShell combinations.
Set-NssmEnvironmentBlock -Name $ServiceName -Entries $serviceEnvironment
Set-Service -Name $ServiceName -StartupType Automatic
Write-Host "[FAR2] Service environment REG_MULTI_SZ verified: $($serviceEnvironment.Count)/$($serviceEnvironment.Count)"

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$fullTaskName = "$TaskName-$uin"

# Incremental multi-session install: only replace the selected QQ task.
# Never delete FAR2CodeAgent-* tasks belonging to other Windows users/UINs.
$oldTask = Get-ScheduledTask -TaskName $fullTaskName -ErrorAction SilentlyContinue
if ($oldTask) {
    try { Stop-ScheduledTask -TaskName $fullTaskName -ErrorAction SilentlyContinue } catch {}
    try { Unregister-ScheduledTask -TaskName $fullTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
}

$taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -Uin $uin -Port $resolvedPort -TokenEnv $resolvedTokenEnv -NodePath `"$nodePath`" -ProjectRoot `"$projectRoot`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $fullTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "FAR2 isolated Code Agent for QQ $uin" -Force | Out-Null

try { Start-ScheduledTask -TaskName $fullTaskName } catch {}
Start-Service -Name $ServiceName
Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$task = Get-ScheduledTask -TaskName $fullTaskName -ErrorAction SilentlyContinue
$svcState = if ($svc) { [string]$svc.Status } else { 'Missing' }
$taskState = if ($task) { [string]$task.State } else { 'Missing' }

$maskedTargets = @($targets.Keys | ForEach-Object { Mask-Uin -Value ([string]$_) })
Write-Host ''
Write-Host '=== FAR2 background install/update complete ===' -ForegroundColor Green
Write-Host "NSSM service: $ServiceName state=$svcState startup=Automatic"
Write-Host "Code Agent task: $fullTaskName state=$taskState trigger=AtLogOn Hidden user=$currentUser"
Write-Host "Provider targets: count=$($targets.Count) qq=$($maskedTargets -join ',')"
Write-Host "Selected Agent: 127.0.0.1:$resolvedPort tokenEnv=$resolvedTokenEnv"
Write-Host 'WebUI: http://127.0.0.1:3007'
Write-Host 'Refresh mode: event-only; no healthy periodic QQ Farm re-login.'
Write-Host 'Provider target config: merged Base64 mapping in verified NSSM REG_MULTI_SZ environment.'
Write-Host 'To add another QQ, sign in to its separate Windows user Session and run install-windows-service.cmd there; existing targets/tasks are preserved.'
