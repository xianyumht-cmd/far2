param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$BaseUrl = 'http://127.0.0.1:3007',
    [string]$Username = 'admin',
    [string]$WechatAccountId = '3'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$expectedAppId = 'wx5306c5978fdb76e4'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupRoot = Join-Path $env:LOCALAPPDATA ("FAR2\wechat-refresh-policy-backup\{0}" -f $stamp)
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$mutated = $false
$restartDone = $false
$rollbackAttempted = $false
$rollbackSucceeded = $false

function Get-Prop {
    param([object]$Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    return $prop.Value
}

function Get-ServiceConfig {
    param([string]$Name)
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    $props = Get-ItemProperty -Path $key -ErrorAction Stop
    return [pscustomobject]@{
        State = [string]$svc.State
        ProcessId = [int]$svc.ProcessId
        AppDirectory = [IO.Path]::GetFullPath([string](Get-Prop $props 'AppDirectory' ''))
        Application = [string](Get-Prop $props 'Application' '')
    }
}

function Get-NodePath {
    param([object]$Service)
    $candidate = [string]$Service.Application
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($node) { return [string]$node.Source }
    throw 'Node executable not found.'
}

function Test-AgentHealth {
    $token = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
    if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
        return [pscustomobject]@{ Available=$false; Reason='provider_token_missing'; AppId='' }
    }
    try {
        $headers = @{ Authorization = "Bearer $token"; Accept='application/json'; 'Cache-Control'='no-store' }
        $res = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:43201/v1/health' -Headers $headers -TimeoutSec 6
        return [pscustomobject]@{
            Available = ($res.ok -eq $true -and $res.available -eq $true)
            Reason = [string](Get-Prop $res 'reason' 'ok')
            AppId = [string](Get-Prop $res 'appId' '')
        }
    } catch {
        return [pscustomobject]@{ Available=$false; Reason='provider_health_failed'; AppId='' }
    }
}

function SecureString-ToPlain {
    param([Security.SecureString]$Secure)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Json {
    param([string]$Method,[string]$Uri,[hashtable]$Headers=@{},[object]$Body=$null)
    $args = @{ Method=$Method; Uri=$Uri; Headers=$Headers; TimeoutSec=10; ErrorAction='Stop' }
    if ($null -ne $Body) {
        $args.ContentType = 'application/json; charset=utf-8'
        $args.Body = ($Body | ConvertTo-Json -Compress -Depth 8)
    }
    Invoke-RestMethod @args
}

function Login-Admin {
    param([string]$Base,[string]$User,[string]$Password)
    $res = Invoke-Json -Method Post -Uri "$Base/api/login" -Body @{ username=$User; password=$Password }
    if (-not $res.ok -or -not $res.data -or [string]::IsNullOrWhiteSpace([string]$res.data.token)) { throw 'FAR2 admin login failed.' }
    return [string]$res.data.token
}

function Get-AccountsApi {
    param([string]$Base,[string]$Token)
    $res = Invoke-Json -Method Get -Uri "$Base/api/accounts" -Headers @{ 'x-admin-token'=$Token; Accept='application/json' }
    if (-not $res.ok -or -not $res.data) { throw 'FAR2 accounts API failed.' }
    return @($res.data.accounts)
}

function Wait-ServiceNewPid {
    param([string]$Name,[int]$OldPid,[int]$TimeoutSec=45)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        Start-Sleep -Milliseconds 500
        $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
        if ($svc -and [string]$svc.State -eq 'Running' -and [int]$svc.ProcessId -gt 0 -and [int]$svc.ProcessId -ne $OldPid) {
            return [int]$svc.ProcessId
        }
    } while ((Get-Date) -lt $deadline)
    throw "$Name did not return with a new PID."
}

function Get-IdentitySnapshot {
    param([object[]]$Accounts)
    return @($Accounts | ForEach-Object {
        [pscustomobject]@{
            id = [string]$_.id
            name = [string]$_.name
            platform = [string]$_.platform
            username = [string](Get-Prop $_ 'username' '')
        }
    } | Sort-Object id)
}

function Same-IdentitySnapshot {
    param([object[]]$A,[object[]]$B)
    return (($A | ConvertTo-Json -Compress -Depth 4) -eq ($B | ConvertTo-Json -Compress -Depth 4))
}

Write-Host ''
Write-Host 'FAR2 WeChat On-Invalid Code Refresh Policy Apply' -ForegroundColor Cyan
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host 'Changes only WeChatRecoveryManager policy: no 3-minute refresh; refresh only on invalid-session events, explicit enrollment/manual trigger, or retry after such an event.' -ForegroundColor DarkGray
Write-Host 'FAR2Farm is restarted once. Production accounts are not intentionally edited.' -ForegroundColor DarkGray
Write-Host ''

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run from elevated Administrator PowerShell.' }

$service = Get-ServiceConfig -Name $ServiceName
if ($service.State -ne 'Running' -or $service.ProcessId -le 0) { throw "$ServiceName is not Running." }
$oldPid = $service.ProcessId
$productionCore = $service.AppDirectory
$node = Get-NodePath -Service $service
$sourceManager = Join-Path $projectRoot 'core\src\services\wechat-recovery-manager.js'
$prodManager = Join-Path $productionCore 'src\services\wechat-recovery-manager.js'
if (-not (Test-Path -LiteralPath $sourceManager -PathType Leaf) -or -not (Test-Path -LiteralPath $prodManager -PathType Leaf)) { throw 'WeChatRecoveryManager path missing.' }

$sourceText = Get-Content -LiteralPath $sourceManager -Raw -Encoding UTF8
if (-not $sourceText.Contains("const REFRESH_POLICY = 'on_invalid';") -or -not $sourceText.Contains('refreshIntervalMs: 0') -or $sourceText.Contains('DEFAULT_REFRESH_INTERVAL_MS')) {
    throw 'Source WeChatRecoveryManager is not the expected on-invalid policy build.'
}
& $node --check $sourceManager *> $null
if ($LASTEXITCODE -ne 0) { throw 'Source WeChatRecoveryManager syntax check failed.' }

$agent = Test-AgentHealth
if (-not $agent.Available -or $agent.AppId -ne $expectedAppId) {
    throw "Resident Agent must be resident_connected before policy deployment ($($agent.Reason)). No production files were modified."
}

$base = $BaseUrl.TrimEnd('/')
$secure = Read-Host "FAR2 admin password for '$Username'" -AsSecureString
$password = SecureString-ToPlain $secure
$secure = $null
if ([string]::IsNullOrWhiteSpace($password)) { throw 'Admin password is empty.' }
$token = Login-Admin -Base $base -User $Username -Password $password
$password = $null
$beforeAccounts = @(Get-AccountsApi -Base $base -Token $token)
$identityBefore = @(Get-IdentitySnapshot $beforeAccounts)
$runningBeforeIds = @($beforeAccounts | Where-Object { $_.running -eq $true } | ForEach-Object { [string]$_.id })
try { Invoke-Json -Method Post -Uri "$base/api/logout" -Headers @{ 'x-admin-token'=$token } | Out-Null } catch {}
$token = $null

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupManager = Join-Path $backupRoot 'wechat-recovery-manager.js'
Copy-Item -LiteralPath $prodManager -Destination $backupManager -Force

try {
    Copy-Item -LiteralPath $sourceManager -Destination $prodManager -Force
    $mutated = $true
    & $node --check $prodManager *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Production WeChatRecoveryManager syntax check failed after copy.' }

    Restart-Service -Name $ServiceName -Force -ErrorAction Stop
    $restartDone = $true
    $newPid = Wait-ServiceNewPid -Name $ServiceName -OldPid $oldPid -TimeoutSec 45

    $deadlineApi = (Get-Date).AddSeconds(60)
    $apiReady = $false
    do {
        try {
            Invoke-RestMethod -Method Get -Uri "$base/api/game-version" -TimeoutSec 5 -ErrorAction Stop | Out-Null
            $apiReady = $true
            break
        } catch { Start-Sleep -Seconds 2 }
    } while ((Get-Date) -lt $deadlineApi)
    if (-not $apiReady) { throw 'FAR2 admin API did not recover after restart.' }

    $secure2 = Read-Host "Re-enter FAR2 admin password for post-restart verification" -AsSecureString
    $password2 = SecureString-ToPlain $secure2
    $secure2 = $null
    $token2 = Login-Admin -Base $base -User $Username -Password $password2
    $password2 = $null

    $deadlineWorkers = (Get-Date).AddSeconds(210)
    $afterAccounts = @()
    $workersRecovered = $false
    do {
        $afterAccounts = @(Get-AccountsApi -Base $base -Token $token2)
        $afterRunning = @($afterAccounts | Where-Object { $_.running -eq $true } | ForEach-Object { [string]$_.id })
        $missing = @($runningBeforeIds | Where-Object { $afterRunning -notcontains $_ })
        if ($missing.Count -eq 0) { $workersRecovered = $true; break }
        Write-Host ("Waiting production workers after policy restart... remaining~{0}s" -f [Math]::Max(0,[int](($deadlineWorkers-(Get-Date)).TotalSeconds)))
        Start-Sleep -Seconds 5
    } while ((Get-Date) -lt $deadlineWorkers)
    if (-not $workersRecovered) { throw 'Previously running production workers did not all recover.' }

    $headers = @{ 'x-admin-token'=$token2; 'x-account-id'=[string]$WechatAccountId; Accept='application/json' }
    $statusRes = Invoke-Json -Method Get -Uri "$base/api/code-manager/status" -Headers $headers
    $refreshInterval = [int64](Get-Prop (Get-Prop $statusRes 'data' $null) 'refreshIntervalMs' -1)
    if ($refreshInterval -ne 0) { throw "WeChat CodeManager still reports periodic refreshIntervalMs=$refreshInterval" }

    $identityAfter = @(Get-IdentitySnapshot $afterAccounts)
    if (-not (Same-IdentitySnapshot $identityBefore $identityAfter)) { throw 'Production account identity snapshot changed unexpectedly.' }
    $agentAfter = Test-AgentHealth
    if (-not $agentAfter.Available -or $agentAfter.AppId -ne $expectedAppId) { throw 'Resident Agent is not ready after policy restart.' }

    try { Invoke-Json -Method Post -Uri "$base/api/logout" -Headers @{ 'x-admin-token'=$token2 } | Out-Null } catch {}
    $token2 = $null

    New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
    $reportPath = Join-Path $reportRoot ("wechat-on-invalid-refresh-policy-apply-{0}.json" -f $stamp)
    $report = [ordered]@{
        version = 1
        phase = 'wechat-on-invalid-refresh-policy-controlled-apply'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        production = [ordered]@{
            serviceName = $ServiceName
            pidBefore = $oldPid
            pidAfter = $newPid
            restartedOnce = $true
            accountIdentityUnchanged = $true
            previouslyRunningWorkersRecovered = $workersRecovered
        }
        policy = [ordered]@{
            mode = 'on_invalid'
            periodicRefreshDisabled = $true
            refreshIntervalMs = 0
            invalidTriggers = @('ws_400','non_version_kickout')
            explicitTriggers = @('web_enroll','manual')
            retryAfterTriggeredFailure = $true
        }
        provider = [ordered]@{ readyBefore=$agent.Available; readyAfter=$agentAfter.Available; appId=$agentAfter.AppId }
        backup = [ordered]@{ path=$backupRoot }
        safety = [ordered]@{ rawCodePrinted=$false; providerTokenPrinted=$false; productionGitReset=$false; productionGitCheckout=$false; productionGitClean=$false }
        gatePassed = $true
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

    Write-Host ''
    Write-Host 'WeChat on-invalid refresh policy apply PASSED.' -ForegroundColor Green
    Write-Host ("FAR2Farm PID: {0} -> {1}" -f $oldPid,$newPid)
    Write-Host 'Periodic 3-minute WeChat Code refresh: DISABLED' -ForegroundColor Green
    Write-Host 'Automatic refresh triggers: ws_400 / non-version kickout only' -ForegroundColor Green
    Write-Host 'Explicit web enrollment/manual refresh remains available.' -ForegroundColor Green
    Write-Host ("Previously running workers recovered: {0}" -f $workersRecovered) -ForegroundColor Green
    Write-Host ("Report: {0}" -f $reportPath)
}
catch {
    if ($mutated) {
        $rollbackAttempted = $true
        try {
            Copy-Item -LiteralPath $backupManager -Destination $prodManager -Force
            & $node --check $prodManager *> $null
            if ($LASTEXITCODE -ne 0) { throw 'Rollback manager syntax invalid.' }
            Restart-Service -Name $ServiceName -Force -ErrorAction Stop
            Wait-ServiceNewPid -Name $ServiceName -OldPid 0 -TimeoutSec 45 | Out-Null
            $rollbackSucceeded = $true
        } catch { $rollbackSucceeded = $false }
    }
    Write-Host ("Rollback attempted/succeeded: {0}/{1}" -f $rollbackAttempted,$rollbackSucceeded) -ForegroundColor Yellow
    throw
}
