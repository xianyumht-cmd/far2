param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$AccountName = '微信农场'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$backupBase = Join-Path $env:LOCALAPPDATA 'FAR2\p8-production-account-backup'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupRoot = Join-Path $backupBase $stamp
$expectedAppId = 'wx5306c5978fdb76e4'
$helper = Join-Path $projectRoot 'core\scripts\wechat-production-account-enroll.js'

function Get-Prop {
    param([object]$Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    return $prop.Value
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "JSON file missing: $Path" }
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-Report {
    param([object]$Report, [string]$Path)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $Report | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Accounts {
    param([object]$Data)
    $value = Get-Prop $Data 'accounts' @()
    if ($value -is [System.Array]) { return @($value) }
    if ($null -eq $value) { return @() }
    return @($value)
}

function Get-AccountById {
    param([object]$Data, [string]$AccountId)
    return @(Get-Accounts $Data | Where-Object { [string](Get-Prop $_ 'id' '') -eq $AccountId }) | Select-Object -First 1
}

function Get-WxAccounts {
    param([object]$Data)
    return @(Get-Accounts $Data | Where-Object { ([string](Get-Prop $_ 'platform' 'qq')).ToLowerInvariant() -eq 'wx' })
}

function Get-QqIdentitySnapshot {
    param([object]$Data)
    $snapshot = @{}
    foreach ($account in @(Get-Accounts $Data)) {
        $platform = [string](Get-Prop $account 'platform' 'qq')
        if ($platform.ToLowerInvariant() -eq 'wx') { continue }
        $id = [string](Get-Prop $account 'id' '')
        if (-not $id) { continue }
        # Intentionally exclude volatile Code/nick/timestamps. This snapshot proves
        # the WeChat gate did not rewrite QQ identity/ownership/protocol fields.
        $snapshot[$id] = [ordered]@{
            id = $id
            platform = $platform
            uin = [string](Get-Prop $account 'uin' '')
            qq = [string](Get-Prop $account 'qq' '')
            username = [string](Get-Prop $account 'username' '')
            name = [string](Get-Prop $account 'name' '')
        }
    }
    return $snapshot
}

function Compare-QqIdentitySnapshot {
    param([hashtable]$Before, [hashtable]$After)
    $beforeKeys = @($Before.Keys | Sort-Object)
    $afterKeys = @($After.Keys | Sort-Object)
    if (($beforeKeys -join "`n") -ne ($afterKeys -join "`n")) { return $false }
    foreach ($key in $beforeKeys) {
        $a = $Before[$key] | ConvertTo-Json -Compress -Depth 6
        $b = $After[$key] | ConvertTo-Json -Compress -Depth 6
        if ($a -ne $b) { return $false }
    }
    return $true
}

function Get-ServiceConfig {
    param([string]$Name)
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (-not (Test-Path -LiteralPath $key)) { throw "NSSM service parameters key missing: $key" }
    $props = Get-ItemProperty -Path $key -ErrorAction Stop
    $appDirectory = [string](Get-Prop $props 'AppDirectory' '')
    if ([string]::IsNullOrWhiteSpace($appDirectory)) { throw 'FAR2Farm AppDirectory is empty.' }
    $extraRaw = Get-Prop $props 'AppEnvironmentExtra' @()
    $extra = if ($extraRaw -is [System.Array]) { @($extraRaw | ForEach-Object { [string]$_ }) }
        elseif ($null -ne $extraRaw -and -not [string]::IsNullOrWhiteSpace([string]$extraRaw)) { @([string]$extraRaw) }
        else { @() }
    return [pscustomobject]@{
        State = [string]$svc.State
        ProcessId = [int]$svc.ProcessId
        AppDirectory = [IO.Path]::GetFullPath($appDirectory)
        Application = [string](Get-Prop $props 'Application' '')
        AppParameters = [string](Get-Prop $props 'AppParameters' '')
        AppEnvironmentExtra = [string[]]$extra
    }
}

function Find-NodeExe {
    param([object]$Service)
    $candidate = [string]$Service.Application
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($node) { return [string]$node.Source }
    $fallback = 'D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw 'Node executable was not found.'
}

function Get-LatestApplyReport {
    if (-not (Test-Path -LiteralPath $reportRoot)) { return $null }
    $files = @(Get-ChildItem -LiteralPath $reportRoot -Filter 'wechat-p8-production-apply-*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    foreach ($file in $files) {
        try {
            $data = Read-JsonFile $file.FullName
            if ([string](Get-Prop $data 'phase' '') -eq 'wechat-p8-controlled-production-apply' -and (Get-Prop $data 'gatePassed' $false) -eq $true) {
                return [pscustomobject]@{ Path=$file.FullName; Data=$data }
            }
        } catch {}
    }
    return $null
}

function Test-AgentHealth {
    param([string]$Url, [string]$Token)
    if ([string]::IsNullOrWhiteSpace($Url)) { $Url = 'http://127.0.0.1:43201/' }
    if ([string]::IsNullOrWhiteSpace($Token) -or $Token.Length -lt 24) {
        return [pscustomobject]@{ Available=$false; Reason='machine_provider_token_missing'; AppId=''; ClientVersion='' }
    }
    try {
        $endpoint = ([Uri]::new([Uri]$Url, 'v1/health')).AbsoluteUri
        $headers = @{ Authorization = "Bearer $Token"; Accept='application/json'; 'Cache-Control'='no-store' }
        $res = Invoke-RestMethod -Method Get -Uri $endpoint -Headers $headers -TimeoutSec 8
        return [pscustomobject]@{
            Available = ((Get-Prop $res 'ok' $false) -eq $true -and (Get-Prop $res 'available' $false) -eq $true)
            Reason = [string](Get-Prop $res 'reason' 'ok')
            AppId = [string](Get-Prop $res 'appId' '')
            ClientVersion = [string](Get-Prop $res 'clientVersion' '')
        }
    } catch {
        return [pscustomobject]@{ Available=$false; Reason='provider_health_failed'; AppId=''; ClientVersion='' }
    }
}

function Get-SafeWxSnapshot {
    param([object]$Account)
    if ($null -eq $Account) { return $null }
    return [ordered]@{
        accountId = [string](Get-Prop $Account 'id' '')
        accountName = [string](Get-Prop $Account 'name' '')
        nick = [string](Get-Prop $Account 'nick' '')
        platform = [string](Get-Prop $Account 'platform' '')
        codeLength = ([string](Get-Prop $Account 'code' '')).Length
        codeRefreshEnabled = ((Get-Prop $Account 'codeRefreshEnabled' $false) -eq $true)
        codeRefreshMode = [string](Get-Prop $Account 'codeRefreshMode' '')
        lastCodeRefreshAt = [int64](Get-Prop $Account 'lastCodeRefreshAt' 0)
        lastCodeRefreshOk = ((Get-Prop $Account 'lastCodeRefreshOk' $false) -eq $true)
        lastCodeRefreshReason = [string](Get-Prop $Account 'lastCodeRefreshReason' '')
        lastCodeSource = [string](Get-Prop $Account 'lastCodeSource' '')
        clientVersion = [string](Get-Prop $Account 'clientVersion' '')
        gatewayVersion = [string](Get-Prop $Account 'gatewayVersion' '')
        wmpfVersion = [int](Get-Prop $Account 'wmpfVersion' 0)
        wechatAppId = [string](Get-Prop $Account 'wechatAppId' '')
    }
}

function Wait-ForProductionRefresh {
    param(
        [string]$AccountsPath,
        [string]$AccountId,
        [int64]$AfterRefreshAt,
        [int]$ServicePid,
        [int]$TimeoutSec,
        [bool]$RequireNick,
        [string]$Label
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $nextProgress = Get-Date
    $lastSnapshot = $null
    while ((Get-Date) -lt $deadline) {
        $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
        if (-not $svc -or [string]$svc.State -ne 'Running' -or [int]$svc.ProcessId -ne $ServicePid) {
            throw "$Label aborted: FAR2Farm PID/state changed during scoped WeChat gate."
        }
        $data = Read-JsonFile $AccountsPath
        $account = Get-AccountById -Data $data -AccountId $AccountId
        if ($null -eq $account) { throw "$Label aborted: enrolled WeChat account disappeared." }
        $lastSnapshot = Get-SafeWxSnapshot $account
        $fresh = $lastSnapshot.lastCodeRefreshAt -gt $AfterRefreshAt `
            -and $lastSnapshot.lastCodeRefreshOk -eq $true `
            -and $lastSnapshot.codeLength -eq 32 `
            -and $lastSnapshot.wechatAppId -eq $expectedAppId
        $nickReady = (-not $RequireNick) -or (-not [string]::IsNullOrWhiteSpace([string]$lastSnapshot.nick))
        if ($fresh -and $nickReady) { return [pscustomobject]$lastSnapshot }
        if ((Get-Date) -ge $nextProgress) {
            $remaining = [Math]::Max(0, [int][Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
            Write-Host ("Waiting {0}: refreshAt={1}, codeLength={2}, nickReady={3}, remaining~{4}s" -f $Label, $lastSnapshot.lastCodeRefreshAt, $lastSnapshot.codeLength, (-not [string]::IsNullOrWhiteSpace([string]$lastSnapshot.nick)), $remaining) -ForegroundColor DarkGray
            $nextProgress = (Get-Date).AddSeconds(15)
        }
        Start-Sleep -Seconds 2
    }
    $summary = if ($lastSnapshot) { "refreshAt=$($lastSnapshot.lastCodeRefreshAt), codeLength=$($lastSnapshot.codeLength), reason=$($lastSnapshot.lastCodeRefreshReason)" } else { 'no snapshot' }
    throw "$Label timed out ($summary)."
}

function Restore-BackupFile {
    param([string]$Backup, [string]$Destination, [bool]$OriginallyExisted)
    if (-not $OriginallyExisted) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        return
    }
    $tmp = "$Destination.rollback-$PID.tmp"
    Copy-Item -LiteralPath $Backup -Destination $tmp -Force
    Move-Item -LiteralPath $tmp -Destination $Destination -Force
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 Final Production Account Gate' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host 'This step creates/resumes ONE real production platform=wx account.' -ForegroundColor DarkGray
Write-Host 'The running FAR2Farm service is NOT restarted by this gate.' -ForegroundColor DarkGray
Write-Host 'RecoveryManager obtains fresh Code itself; raw Code/token are never printed or written to the report.' -ForegroundColor DarkGray
Write-Host 'After the first real login, normal FAR2 production worker routines may run for this WeChat account.' -ForegroundColor Yellow
Write-Host 'The gate then waits for a second scoped refresh while requiring FAR2Farm PID and QQ identity to stay unchanged.' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "Enrollment helper missing: $helper" }

$applyReport = Get-LatestApplyReport
if (-not $applyReport) { throw 'No successful controlled production apply report was found.' }
$applyData = $applyReport.Data
$service = Get-ServiceConfig -Name $ServiceName
if ($service.State -ne 'Running' -or $service.ProcessId -le 0) { throw "Production service $ServiceName is not Running." }

$productionCore = $service.AppDirectory
$productionRoot = Split-Path -Parent $productionCore
$expectedWorktree = [string](Get-Prop (Get-Prop $applyData 'production' $null) 'worktree' '')
$expectedCore = [string](Get-Prop (Get-Prop $applyData 'production' $null) 'appDirectory' '')
$expectedPid = [int](Get-Prop (Get-Prop $applyData 'production' $null) 'servicePidAfter' 0)
if ($expectedWorktree -ne $productionRoot -or $expectedCore -ne $productionCore) { throw 'FAR2Farm path changed after controlled apply.' }
if ($expectedPid -gt 0 -and $service.ProcessId -ne $expectedPid) { throw 'FAR2Farm PID changed after controlled apply. Re-run readiness before enrollment.' }

$machineUrl = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', 'Machine')
$machineToken = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
$agent = Test-AgentHealth -Url $machineUrl -Token $machineToken
if (-not $agent.Available -or $agent.AppId -ne $expectedAppId) { throw "Resident Agent is not ready: $($agent.Reason)" }

$extra = @($service.AppEnvironmentExtra)
$hasServiceUrl = @($extra | Where-Object { $_ -like 'FARM_WECHAT_CODE_PROVIDER_URL=*' }).Count -eq 1
$hasServiceToken = @($extra | Where-Object { $_ -like 'FARM_WECHAT_CODE_PROVIDER_TOKEN=*' }).Count -eq 1
if (-not $hasServiceUrl -or -not $hasServiceToken) { throw 'FAR2Farm NSSM Provider env is not explicitly configured.' }

$accountsPath = Join-Path $productionCore 'data\accounts.json'
$storePath = Join-Path $productionCore 'data\store.json'
$accountsBeforeData = Read-JsonFile $accountsPath
$wxBefore = @(Get-WxAccounts $accountsBeforeData)
if ($wxBefore.Count -gt 1) { throw "Refusing enrollment: production already has $($wxBefore.Count) WeChat accounts." }
$qqBefore = Get-QqIdentitySnapshot $accountsBeforeData
$accountsHashBefore = Get-FileSha256 $accountsPath
$storeExistedBefore = Test-Path -LiteralPath $storePath -PathType Leaf
$storeHashBefore = if ($storeExistedBefore) { Get-FileSha256 $storePath } else { '' }

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupAccounts = Join-Path $backupRoot 'accounts.json'
Copy-Item -LiteralPath $accountsPath -Destination $backupAccounts -Force
$backupStore = Join-Path $backupRoot 'store.json'
if ($storeExistedBefore) { Copy-Item -LiteralPath $storePath -Destination $backupStore -Force }

$reportPath = Join-Path $reportRoot ("wechat-p8-production-account-gate-{0}.json" -f $stamp)
$createdThisRun = $false
$accountId = ''
$baselineRefreshAt = 0L
$firstRefresh = $null
$secondRefresh = $null
$activationObserved = $false
$rollbackAttempted = $false
$rollbackSucceeded = $false

$report = [ordered]@{
    version = 1
    phase = 'wechat-p8-final-production-account-gate'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{
        controlledApplyReport = $applyReport.Path
        probeWorktree = $projectRoot
    }
    production = [ordered]@{
        serviceName = $ServiceName
        worktree = $productionRoot
        appDirectory = $productionCore
        servicePidBefore = $service.ProcessId
        servicePidAfter = 0
        servicePidUnchanged = $false
        qqCountBefore = $qqBefore.Count
        qqCountAfter = 0
        qqIdentityUnchanged = $false
    }
    enrollment = [ordered]@{
        createdThisRun = $false
        accountId = ''
        accountName = ''
        owner = ''
        appId = $expectedAppId
        configuredForResidentRecovery = $false
        initialCodeLength = 0
    }
    firstRefresh = $null
    secondRefresh = $null
    provider = [ordered]@{
        residentReadyBefore = $agent.Available
        residentReadyAfter = $false
        appId = $agent.AppId
        clientVersion = $agent.ClientVersion
        tokenPrinted = $false
    }
    safety = [ordered]@{
        serviceRestartedByGate = $false
        rawCodePrinted = $false
        rawCodeWrittenToReport = $false
        providerTokenPrinted = $false
        diagnosticFarmWritesInjected = $false
        normalProductionWorkerRoutinesMayRun = $true
        gitResetCheckoutCleanUsed = $false
    }
    rollback = [ordered]@{
        attempted = $false
        succeeded = $false
        onlyAllowedBeforeFirstActivation = $true
        reason = ''
    }
    gatePassed = $false
}

try {
    Write-Host ("Production service: {0} / PID {1}" -f $ServiceName, $service.ProcessId)
    Write-Host ("Resident Agent: ready / appId={0}" -f $agent.AppId)
    Write-Host ("Production accounts before gate: total={0} qq={1} wx={2}" -f @(Get-Accounts $accountsBeforeData).Count, $qqBefore.Count, $wxBefore.Count)
    Write-Host ("Backup: {0}" -f $backupRoot)
    Write-Host ''

    if ($wxBefore.Count -eq 0) {
        $node = Find-NodeExe -Service $service
        $oldCore = $env:FAR2_PRODUCTION_CORE
        $oldName = $env:FAR2_WECHAT_ACCOUNT_NAME
        try {
            $env:FAR2_PRODUCTION_CORE = $productionCore
            $env:FAR2_WECHAT_ACCOUNT_NAME = $AccountName
            $helperOutput = @(& $node $helper 2>&1)
            $helperExit = $LASTEXITCODE
        }
        finally {
            $env:FAR2_PRODUCTION_CORE = $oldCore
            $env:FAR2_WECHAT_ACCOUNT_NAME = $oldName
        }
        $resultLine = @($helperOutput | ForEach-Object { [string]$_ } | Where-Object { $_ -like 'FAR2_ENROLL_RESULT=*' }) | Select-Object -Last 1
        if (-not $resultLine) { throw "Enrollment helper returned no sanitized result (exit=$helperExit)." }
        $result = $resultLine.Substring('FAR2_ENROLL_RESULT='.Length) | ConvertFrom-Json
        if ($helperExit -ne 0 -or (Get-Prop $result 'ok' $false) -ne $true) {
            throw "Enrollment helper failed: $([string](Get-Prop $result 'reason' 'unknown'))"
        }
        $createdThisRun = $true
        $accountId = [string](Get-Prop $result 'accountId' '')
        $report.enrollment.createdThisRun = $true
        $report.enrollment.accountId = $accountId
        $report.enrollment.accountName = [string](Get-Prop $result 'accountName' $AccountName)
        $report.enrollment.owner = [string](Get-Prop $result 'owner' 'unassigned')
        $report.enrollment.initialCodeLength = [int](Get-Prop $result 'initialCodeLength' 0)
        Write-Host ("Created production WeChat account metadata: id={0}, name={1}, owner={2}" -f $accountId, $report.enrollment.accountName, $report.enrollment.owner) -ForegroundColor Green
    }
    else {
        $existing = $wxBefore[0]
        $accountId = [string](Get-Prop $existing 'id' '')
        $report.enrollment.accountId = $accountId
        $report.enrollment.accountName = [string](Get-Prop $existing 'name' $AccountName)
        $report.enrollment.owner = [string](Get-Prop $existing 'username' '')
        $report.enrollment.initialCodeLength = ([string](Get-Prop $existing 'code' '')).Length
        Write-Host ("Resuming existing production WeChat account: id={0}, name={1}" -f $accountId, $report.enrollment.accountName) -ForegroundColor Yellow
    }

    if (-not $accountId) { throw 'Enrolled WeChat account id is empty.' }
    $postEnrollData = Read-JsonFile $accountsPath
    $wxNow = @(Get-WxAccounts $postEnrollData)
    if ($wxNow.Count -ne 1) { throw "Expected exactly one production WeChat account after enrollment; found $($wxNow.Count)." }
    $account = Get-AccountById -Data $postEnrollData -AccountId $accountId
    if ($null -eq $account) { throw 'Enrolled WeChat account is missing after write.' }
    $configured = ([string](Get-Prop $account 'platform' '')).ToLowerInvariant() -eq 'wx' `
        -and (Get-Prop $account 'codeRefreshEnabled' $false) -eq $true `
        -and ([string](Get-Prop $account 'codeRefreshMode' '')).ToLowerInvariant() -eq 'windows_wechat' `
        -and [string](Get-Prop $account 'wechatAppId' '') -eq $expectedAppId
    if (-not $configured) { throw 'Enrolled account is not configured for FAR2 Windows WeChat resident recovery.' }
    $report.enrollment.configuredForResidentRecovery = $true
    $baselineRefreshAt = [int64](Get-Prop $account 'lastCodeRefreshAt' 0)

    $svcAfterEnroll = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop
    if ([string]$svcAfterEnroll.State -ne 'Running' -or [int]$svcAfterEnroll.ProcessId -ne $service.ProcessId) {
        throw 'FAR2Farm changed during account enrollment.'
    }

    Write-Host ''
    Write-Host 'Waiting for first real production fresh Code + worker login (normally about 3 minutes)...' -ForegroundColor Cyan
    $firstRefresh = Wait-ForProductionRefresh -AccountsPath $accountsPath -AccountId $accountId -AfterRefreshAt $baselineRefreshAt -ServicePid $service.ProcessId -TimeoutSec 390 -RequireNick $true -Label 'first production refresh/login'
    $activationObserved = $true
    $report.firstRefresh = [ordered]@{
        observed = $true
        at = $firstRefresh.lastCodeRefreshAt
        ok = $firstRefresh.lastCodeRefreshOk
        reason = $firstRefresh.lastCodeRefreshReason
        source = $firstRefresh.lastCodeSource
        codeLength = $firstRefresh.codeLength
        nickObserved = (-not [string]::IsNullOrWhiteSpace([string]$firstRefresh.nick))
        clientVersion = $firstRefresh.clientVersion
        gatewayVersion = $firstRefresh.gatewayVersion
        wmpfVersion = $firstRefresh.wmpfVersion
        appId = $firstRefresh.wechatAppId
    }
    Write-Host ("First production login ready: reason={0}, codeLength={1}, nickReady=True" -f $firstRefresh.lastCodeRefreshReason, $firstRefresh.codeLength) -ForegroundColor Green

    Write-Host ''
    Write-Host 'Waiting for second scoped production refresh (normally another 3 minutes)...' -ForegroundColor Cyan
    $secondRefresh = Wait-ForProductionRefresh -AccountsPath $accountsPath -AccountId $accountId -AfterRefreshAt $firstRefresh.lastCodeRefreshAt -ServicePid $service.ProcessId -TimeoutSec 330 -RequireNick $false -Label 'second scoped production refresh'
    $report.secondRefresh = [ordered]@{
        observed = $true
        at = $secondRefresh.lastCodeRefreshAt
        ok = $secondRefresh.lastCodeRefreshOk
        reason = $secondRefresh.lastCodeRefreshReason
        source = $secondRefresh.lastCodeSource
        codeLength = $secondRefresh.codeLength
        clientVersion = $secondRefresh.clientVersion
        gatewayVersion = $secondRefresh.gatewayVersion
        wmpfVersion = $secondRefresh.wmpfVersion
        appId = $secondRefresh.wechatAppId
    }
    Write-Host ("Second scoped refresh ready: reason={0}, codeLength={1}" -f $secondRefresh.lastCodeRefreshReason, $secondRefresh.codeLength) -ForegroundColor Green

    Start-Sleep -Seconds 8
    $serviceAfter = Get-ServiceConfig -Name $ServiceName
    $accountsAfterData = Read-JsonFile $accountsPath
    $qqAfter = Get-QqIdentitySnapshot $accountsAfterData
    $wxAfter = @(Get-WxAccounts $accountsAfterData)
    $qqUnchanged = Compare-QqIdentitySnapshot -Before $qqBefore -After $qqAfter
    $pidUnchanged = ($serviceAfter.State -eq 'Running' -and $serviceAfter.ProcessId -eq $service.ProcessId)
    $agentAfter = Test-AgentHealth -Url $machineUrl -Token $machineToken

    $report.production.servicePidAfter = $serviceAfter.ProcessId
    $report.production.servicePidUnchanged = $pidUnchanged
    $report.production.qqCountAfter = $qqAfter.Count
    $report.production.qqIdentityUnchanged = $qqUnchanged
    $report.provider.residentReadyAfter = ($agentAfter.Available -and $agentAfter.AppId -eq $expectedAppId)

    if (-not $pidUnchanged) { throw 'FAR2Farm PID changed during the scoped production refresh gate.' }
    if (-not $qqUnchanged) { throw 'QQ identity/ownership fields changed during the WeChat production gate.' }
    if ($wxAfter.Count -ne 1) { throw "Unexpected WeChat account count after gate: $($wxAfter.Count)." }
    if (-not $report.provider.residentReadyAfter) { throw 'Resident Agent was not ready after the production account gate.' }

    $report.gatePassed = $true
    Write-Report -Report $report -Path $reportPath

    Write-Host ''
    Write-Host 'FAR2 WeChat P8 final production account gate PASSED.' -ForegroundColor Green
    Write-Host ("WeChat account: id={0}, name={1}" -f $accountId, $report.enrollment.accountName)
    Write-Host ("First refresh/login: True / reason={0}" -f $firstRefresh.lastCodeRefreshReason)
    Write-Host ("Second scoped refresh: True / reason={0}" -f $secondRefresh.lastCodeRefreshReason)
    Write-Host 'Fresh Code length: 32 (raw value hidden)'
    Write-Host 'FAR2Farm PID unchanged during account gate: True'
    Write-Host 'QQ identity/ownership unchanged: True'
    Write-Host 'Resident Agent still ready: True'
    Write-Host 'Raw Code/token printed: False'
    Write-Host ''
    Write-Host 'Report path:'
    Write-Host $reportPath
    Write-Host ''
    Write-Host 'Keep the Resident Agent running. The WeChat account is now a real production account.' -ForegroundColor Yellow
    exit 0
}
catch {
    $failure = if ($_.Exception -and $_.Exception.Message) { [string]$_.Exception.Message } else { [string]$_ }
    $report.rollback.reason = $failure
    Write-Host ''
    Write-Host ("Final production account gate failed: {0}" -f $failure) -ForegroundColor Red

    # Exact data rollback is safe only before RecoveryManager has persisted a real
    # fresh Code / started the production worker. After activation we leave the
    # account in place for targeted recovery instead of deleting a potentially live worker.
    try {
        $currentData = Read-JsonFile $accountsPath
        $currentAccount = if ($accountId) { Get-AccountById -Data $currentData -AccountId $accountId } else { $null }
        $currentRefreshAt = if ($currentAccount) { [int64](Get-Prop $currentAccount 'lastCodeRefreshAt' 0) } else { 0L }
        $currentCodeLength = if ($currentAccount) { ([string](Get-Prop $currentAccount 'code' '')).Length } else { 0 }
        $activatedNow = $activationObserved -or ($currentRefreshAt -gt $baselineRefreshAt -and $currentCodeLength -gt 0)
        if ($createdThisRun -and -not $activatedNow) {
            $rollbackAttempted = $true
            Restore-BackupFile -Backup $backupAccounts -Destination $accountsPath -OriginallyExisted $true
            Restore-BackupFile -Backup $backupStore -Destination $storePath -OriginallyExisted $storeExistedBefore
            $rollbackSucceeded = ((Get-FileSha256 $accountsPath) -eq $accountsHashBefore)
            if ($storeExistedBefore) { $rollbackSucceeded = $rollbackSucceeded -and ((Get-FileSha256 $storePath) -eq $storeHashBefore) }
            else { $rollbackSucceeded = $rollbackSucceeded -and (-not (Test-Path -LiteralPath $storePath -PathType Leaf)) }
        }
    } catch {
        $rollbackSucceeded = $false
        $report.rollback.reason = $failure + '; rollback_error=' + [string]$_.Exception.Message
    }

    $report.rollback.attempted = $rollbackAttempted
    $report.rollback.succeeded = $rollbackSucceeded
    try {
        $svcNow = Get-ServiceConfig -Name $ServiceName
        $report.production.servicePidAfter = $svcNow.ProcessId
        $report.production.servicePidUnchanged = ($svcNow.State -eq 'Running' -and $svcNow.ProcessId -eq $service.ProcessId)
        $afterData = Read-JsonFile $accountsPath
        $qqAfter = Get-QqIdentitySnapshot $afterData
        $report.production.qqCountAfter = $qqAfter.Count
        $report.production.qqIdentityUnchanged = Compare-QqIdentitySnapshot -Before $qqBefore -After $qqAfter
    } catch {}
    $report.gatePassed = $false
    try { Write-Report -Report $report -Path $reportPath } catch {}

    Write-Host ("Automatic pre-activation rollback attempted: {0}" -f $rollbackAttempted)
    Write-Host ("Automatic pre-activation rollback succeeded: {0}" -f $rollbackSucceeded)
    Write-Host ("Activation had already occurred: {0}" -f $activationObserved)
    Write-Host ''
    Write-Host 'Report path:'
    Write-Host $reportPath
    Write-Host ''
    Write-Host 'Do not delete the WeChat account or restart FAR2Farm manually. Send this output/report for targeted recovery.' -ForegroundColor Yellow
    exit 2
}
