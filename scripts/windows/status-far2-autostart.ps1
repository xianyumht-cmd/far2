param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$TaskPrefix = 'FAR2CodeAgent-',
    [int]$AgentPort = 43101,
    [string]$TokenEnv = 'FAR2_CODE_PROVIDER_TOKEN_A'
)

$ErrorActionPreference = 'SilentlyContinue'

function Mask-Uin {
    param([string]$Uin)
    if ($Uin -notmatch '^\d{5,12}$') { return '' }
    if ($Uin.Length -le 4) { return '****' }
    return $Uin.Substring(0, 2) + '****' + $Uin.Substring($Uin.Length - 2)
}

function Convert-EnvironmentEntriesToMap {
    param([string[]]$Entries)
    $map = [ordered]@{}
    foreach ($entry in @($Entries)) {
        $text = [string]$entry
        $idx = $text.IndexOf('=')
        if ($idx -le 0) { continue }
        $map[$text.Substring(0, $idx)] = $text.Substring($idx + 1)
    }
    return $map
}

function Read-ProviderTargets {
    param($EnvironmentMap)
    $targets = [ordered]@{}
    $raw = ''

    if ($EnvironmentMap.Contains('FARM_CODE_PROVIDER_TARGETS_B64')) {
        try {
            $b64 = [string]$EnvironmentMap['FARM_CODE_PROVIDER_TARGETS_B64']
            if ($b64) {
                $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
            }
        } catch {
            return @{ Ok = $false; Targets = $targets; Reason = 'invalid_base64' }
        }
    } elseif ($EnvironmentMap.Contains('FARM_CODE_PROVIDER_TARGETS')) {
        $raw = [string]$EnvironmentMap['FARM_CODE_PROVIDER_TARGETS']
    }

    if (-not $raw) {
        return @{ Ok = $true; Targets = $targets; Reason = 'not_configured' }
    }

    try {
        $decoded = $raw | ConvertFrom-Json
        foreach ($prop in @($decoded.PSObject.Properties)) {
            $targets[[string]$prop.Name] = $prop.Value
        }
        return @{ Ok = $true; Targets = $targets; Reason = 'ok' }
    } catch {
        return @{ Ok = $false; Targets = $targets; Reason = 'invalid_json' }
    }
}

function Get-TaskState {
    param([string]$TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        return @{ State = 'Missing'; LastResult = ''; User = '' }
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $user = ''
    try { $user = [string]$task.Principal.UserId } catch {}
    return @{
        State = [string]$task.State
        LastResult = if ($info) { [string]$info.LastTaskResult } else { '' }
        User = $user
    }
}

function Test-AgentTarget {
    param(
        [string]$Uin,
        $Spec,
        $EnvironmentMap
    )

    $masked = Mask-Uin -Uin $Uin
    $url = ''
    $tokenName = ''
    try {
        if ($Spec -is [string]) {
            $url = [string]$Spec
        } else {
            $url = [string]$Spec.url
            $tokenName = [string]$Spec.tokenEnv
        }
    } catch {}

    $taskName = "$TaskPrefix$Uin"
    $taskState = Get-TaskState -TaskName $taskName
    Write-Host "Code Agent target: qq=$masked task=$taskName state=$($taskState.State) lastResult=$($taskState.LastResult) user=$($taskState.User) url=$url"

    $uri = $null
    try { $uri = [Uri]$url } catch {}
    if ($uri -and $uri.IsLoopback) {
        try {
            $listener = Get-NetTCPConnection -State Listen -LocalPort $uri.Port -ErrorAction Stop | Select-Object -First 1
            Write-Host "  listener: port=$($uri.Port) LISTEN pid=$($listener.OwningProcess)"
        } catch {
            Write-Host "  listener: port=$($uri.Port) NOT LISTENING"
        }
    } else {
        Write-Host '  listener: remote/non-loopback target (local listener check skipped)'
    }

    $token = ''
    if ($tokenName -and $EnvironmentMap.Contains($tokenName)) {
        $token = [string]$EnvironmentMap[$tokenName]
    }
    if (-not $token -and $tokenName) {
        $token = [Environment]::GetEnvironmentVariable($tokenName, 'User')
    }
    if (-not $token -and -not ($Spec -is [string])) {
        try { $token = [string]$Spec.token } catch {}
    }

    if (-not $token) {
        Write-Host "  auth: MISSING tokenEnv=$tokenName"
        return
    }
    Write-Host "  auth: PRESENT tokenEnv=$tokenName length=$($token.Length)"

    if (-not $url) {
        Write-Host '  health: SKIPPED target URL missing'
        return
    }

    try {
        $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
        $healthUrl = $url.TrimEnd('/') + '/v1/health'
        $health = Invoke-RestMethod -Method Get -Uri $healthUrl -Headers $headers -TimeoutSec 25
        $reportedUin = [string]$health.qqUin
        $identityOk = ($reportedUin -eq $Uin)
        Write-Host "  health: ok=$($health.ok) available=$($health.available) reason=$($health.reason) identityOk=$identityOk qq=$(Mask-Uin -Uin $reportedUin) session=$($health.windowsSessionId) farmSeen=$($health.farmRuntimeSeen)"
    } catch {
        $statusCode = ''
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
        if ($statusCode) {
            Write-Host "  health: HTTP $statusCode"
        } else {
            Write-Host "  health: FAILED $($_.Exception.Message)"
        }
    }
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "NSSM service: $ServiceName  status=$($svc.Status)"
} else {
    Write-Host "NSSM service: $ServiceName  NOT INSTALLED"
}

$tasks = @(Get-ScheduledTask -TaskName "$TaskPrefix*" -ErrorAction SilentlyContinue)
if ($tasks.Count) {
    Write-Host "Code Agent tasks installed: $($tasks.Count)"
    foreach ($task in $tasks) {
        $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -ErrorAction SilentlyContinue
        $user = ''
        try { $user = [string]$task.Principal.UserId } catch {}
        Write-Host "  $($task.TaskName) state=$($task.State) lastResult=$($info.LastTaskResult) user=$user"
    }
} else {
    Write-Host 'Code Agent tasks installed: 0'
}

try {
    $web = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3007/' -TimeoutSec 3
    Write-Host "WebUI: READY http=$($web.StatusCode)"
} catch {
    Write-Host "WebUI: NOT READY ($($_.Exception.Message))"
}

$environmentMap = [ordered]@{}
$targetsResult = @{ Ok = $true; Targets = [ordered]@{}; Reason = 'service_missing' }

if ($svc) {
    $parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
    try {
        $serviceEnv = @((Get-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -ErrorAction Stop).AppEnvironmentExtra)
        $environmentMap = Convert-EnvironmentEntriesToMap -Entries $serviceEnv
        $hasAuto = ($environmentMap['FARM_CODE_AUTO_REFRESH'] -eq '1')
        $eventOnly = ($environmentMap['FARM_CODE_SCHEDULED_REFRESH'] -eq '0')
        $hasB64 = $environmentMap.Contains('FARM_CODE_PROVIDER_TARGETS_B64')
        $hasRaw = $environmentMap.Contains('FARM_CODE_PROVIDER_TARGETS')
        $hasTimeout = ($environmentMap['FARM_CODE_PROVIDER_HEALTH_TIMEOUT_MS'] -eq '20000')
        $intervalMs = [string]$environmentMap['FARM_CODE_REFRESH_INTERVAL_MS']
        $count = $serviceEnv.Count
        Write-Host "Service provider env: auto=$hasAuto eventOnly=$eventOnly targetsB64=$hasB64 targetsRaw=$hasRaw healthTimeout=$hasTimeout entries=$count source=REG_MULTI_SZ"
        Write-Host "Service refresh mode: eventOnly=$eventOnly passiveIntervalMs=$intervalMs"

        $targetsResult = Read-ProviderTargets -EnvironmentMap $environmentMap
        if ($targetsResult.Ok) {
            $keys = @($targetsResult.Targets.Keys)
            $maskedKeys = @($keys | ForEach-Object { Mask-Uin -Uin ([string]$_) })
            Write-Host "Service provider targets: decoded=True count=$($keys.Count) qq=$($maskedKeys -join ',')"
        } else {
            Write-Host "Service provider targets: decoded=False reason=$($targetsResult.Reason)"
        }
    } catch {
        Write-Host "Service provider env: CHECK FAILED source=REG_MULTI_SZ error=$($_.Exception.Message)"
    }
}

if ($targetsResult.Ok -and $targetsResult.Targets.Count -gt 0) {
    Write-Host ''
    Write-Host '=== Per-target Agent health ==='
    foreach ($key in $targetsResult.Targets.Keys) {
        Test-AgentTarget -Uin ([string]$key) -Spec $targetsResult.Targets[$key] -EnvironmentMap $environmentMap
    }

    $targetTaskNames = @($targetsResult.Targets.Keys | ForEach-Object { "$TaskPrefix$_" })
    $orphans = @($tasks | Where-Object { $targetTaskNames -notcontains $_.TaskName })
    if ($orphans.Count) {
        Write-Host ''
        Write-Host "Orphan Agent tasks (not present in Provider targets): $($orphans.Count)"
        $orphans | ForEach-Object { Write-Host "  $($_.TaskName)" }
    }
} else {
    # Legacy fallback for an old single-target installation that predates merged target discovery.
    try {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $AgentPort -ErrorAction Stop | Select-Object -First 1
        Write-Host "Legacy Code Agent port ${AgentPort}: LISTEN pid=$($listener.OwningProcess)"
    } catch {
        Write-Host "Legacy Code Agent port ${AgentPort}: NOT LISTENING"
    }

    $legacyToken = [Environment]::GetEnvironmentVariable($TokenEnv, 'User')
    if ([string]::IsNullOrWhiteSpace($legacyToken)) {
        Write-Host "Legacy Agent auth token: MISSING user-env=$TokenEnv"
    } else {
        Write-Host "Legacy Agent auth token: PRESENT length=$($legacyToken.Length)"
    }
}

$stdout = Join-Path $projectRoot 'core\data\service.stdout.log'
if (Test-Path -LiteralPath $stdout) {
    $matches = @(Get-Content -LiteralPath $stdout -Tail 200 -Encoding UTF8 | Where-Object {
        $_ -match 'isolated QQ runtime Code Provider configured|targeted Provider remains pending|CodeManager|Provider'
    })
    if ($matches.Count) {
        Write-Host ''
        Write-Host 'Recent provider/runtime lines:'
        $matches | Select-Object -Last 12 | ForEach-Object { Write-Host $_ }
    }
}
