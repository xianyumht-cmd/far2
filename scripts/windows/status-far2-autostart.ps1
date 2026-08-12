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

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "NSSM service: $ServiceName  status=$($svc.Status)"
} else {
    Write-Host "NSSM service: $ServiceName  NOT INSTALLED"
}

$tasks = @(Get-ScheduledTask -TaskName "$TaskPrefix*" -ErrorAction SilentlyContinue)
if ($tasks.Count) {
    foreach ($task in $tasks) {
        $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -ErrorAction SilentlyContinue
        Write-Host "Code Agent task: $($task.TaskName)  state=$($task.State)  lastResult=$($info.LastTaskResult)"
    }
} else {
    Write-Host 'Code Agent task: NOT INSTALLED'
}

try {
    $web = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3007/' -TimeoutSec 3
    Write-Host "WebUI: READY http=$($web.StatusCode)"
} catch {
    Write-Host "WebUI: NOT READY ($($_.Exception.Message))"
}

try {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $AgentPort -ErrorAction Stop | Select-Object -First 1
    Write-Host "Code Agent port ${AgentPort}: LISTEN pid=$($listener.OwningProcess)"
} catch {
    Write-Host "Code Agent port ${AgentPort}: NOT LISTENING"
}

$token = [Environment]::GetEnvironmentVariable($TokenEnv, 'User')
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host "Agent auth token: MISSING user-env=$TokenEnv"
} else {
    Write-Host "Agent auth token: PRESENT length=$($token.Length)"
    try {
        $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
        $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$AgentPort/v1/health" -Headers $headers -TimeoutSec 25
        $masked = Mask-Uin -Uin ([string]$health.qqUin)
        Write-Host "Agent health: ok=$($health.ok) available=$($health.available) reason=$($health.reason) qq=$masked session=$($health.windowsSessionId) farmSeen=$($health.farmRuntimeSeen)"
    } catch {
        $statusCode = ''
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
        if ($statusCode) {
            Write-Host "Agent health: HTTP $statusCode"
        } else {
            Write-Host "Agent health: FAILED $($_.Exception.Message)"
        }
    }
}

if ($svc) {
    $parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
    try {
        $serviceEnv = @((Get-ItemProperty -Path $parametersKey -Name 'AppEnvironmentExtra' -ErrorAction Stop).AppEnvironmentExtra)
        $hasAuto = [bool]($serviceEnv | Where-Object { $_ -eq 'FARM_CODE_AUTO_REFRESH=1' })
        $hasB64 = [bool]($serviceEnv | Where-Object { $_ -like 'FARM_CODE_PROVIDER_TARGETS_B64=*' })
        $hasRaw = [bool]($serviceEnv | Where-Object { $_ -like 'FARM_CODE_PROVIDER_TARGETS=*' })
        $hasServiceToken = [bool]($serviceEnv | Where-Object { $_ -like "$TokenEnv=*" })
        $hasTimeout = [bool]($serviceEnv | Where-Object { $_ -eq 'FARM_CODE_PROVIDER_HEALTH_TIMEOUT_MS=20000' })
        $count = $serviceEnv.Count
        Write-Host "Service provider env: auto=$hasAuto targetsB64=$hasB64 targetsRaw=$hasRaw token=$hasServiceToken healthTimeout=$hasTimeout entries=$count source=REG_MULTI_SZ"

        if ($hasB64) {
            $b64Entry = $serviceEnv | Where-Object { $_ -like 'FARM_CODE_PROVIDER_TARGETS_B64=*' } | Select-Object -First 1
            $b64 = $b64Entry.Substring('FARM_CODE_PROVIDER_TARGETS_B64='.Length)
            try {
                $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
                $keys = @($decoded.PSObject.Properties.Name)
                $maskedKeys = @($keys | ForEach-Object { Mask-Uin -Uin ([string]$_) })
                Write-Host "Service provider targets: decoded=True count=$($keys.Count) qq=$($maskedKeys -join ',')"
            } catch {
                Write-Host 'Service provider targets: decoded=False'
            }
        }
    } catch {
        Write-Host "Service provider env: CHECK FAILED source=REG_MULTI_SZ error=$($_.Exception.Message)"
    }
}

$stdout = Join-Path $projectRoot 'core\data\service.stdout.log'
if (Test-Path -LiteralPath $stdout) {
    $matches = @(Get-Content -LiteralPath $stdout -Tail 160 -Encoding UTF8 | Where-Object {
        $_ -match 'isolated QQ runtime Code Provider configured|targeted Provider remains pending|CodeManager|Provider'
    })
    if ($matches.Count) {
        Write-Host 'Recent provider/runtime lines:'
        $matches | Select-Object -Last 10 | ForEach-Object { Write-Host $_ }
    }
}
