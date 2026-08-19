param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'

function Get-Timestamp {
    return (Get-Date).ToString('yyyyMMdd-HHmmss')
}

function Get-SafeMachineEnv {
    param([string]$Name)
    try {
        return [string][Environment]::GetEnvironmentVariable($Name, 'Machine')
    }
    catch {
        return ''
    }
}

function Get-GitSnapshot {
    param([string]$Root)
    $result = [ordered]@{
        available = $false
        root = ''
        head = ''
        branch = ''
        trackedDirty = $null
    }
    if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return [pscustomobject]$result }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { return [pscustomobject]$result }
    try {
        $top = (& $git.Source -C $Root rev-parse --show-toplevel 2>$null).Trim()
        if (-not $top) { return [pscustomobject]$result }
        $head = (& $git.Source -C $Root rev-parse HEAD 2>$null).Trim()
        $branch = (& $git.Source -C $Root branch --show-current 2>$null).Trim()
        $dirtyLines = @(& $git.Source -C $Root status --porcelain --untracked-files=no 2>$null)
        $result.available = $true
        $result.root = [System.IO.Path]::GetFullPath($top)
        $result.head = $head
        $result.branch = $branch
        $result.trackedDirty = ($dirtyLines.Count -gt 0)
    }
    catch {}
    return [pscustomobject]$result
}

function Convert-EnvEntriesToMap {
    param([object[]]$Entries)
    $map = [ordered]@{}
    foreach ($entry in @($Entries)) {
        $text = [string]$entry
        $idx = $text.IndexOf('=')
        if ($idx -le 0) { continue }
        $map[$text.Substring(0, $idx)] = $text.Substring($idx + 1)
    }
    return $map
}

function Read-ServiceSnapshot {
    param([string]$Name)
    $snapshot = [ordered]@{
        found = $false
        status = 'Missing'
        appDirectory = ''
        application = ''
        appParameters = ''
        providerUrlConfigured = $false
        providerTokenConfigured = $false
        providerAutoRefreshConfigured = $false
        accountsFile = ''
    }
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { return [pscustomobject]$snapshot }
    $snapshot.found = $true
    $snapshot.status = [string]$svc.Status

    $parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (Test-Path -LiteralPath $parametersKey) {
        try {
            $props = Get-ItemProperty -Path $parametersKey -ErrorAction Stop
            $snapshot.appDirectory = [string]$props.AppDirectory
            $snapshot.application = [string]$props.Application
            $snapshot.appParameters = [string]$props.AppParameters
            $entries = @($props.AppEnvironmentExtra)
            $map = Convert-EnvEntriesToMap -Entries $entries
            $snapshot.providerUrlConfigured = $map.Contains('FARM_WECHAT_CODE_PROVIDER_URL') -and -not [string]::IsNullOrWhiteSpace([string]$map['FARM_WECHAT_CODE_PROVIDER_URL'])
            $snapshot.providerTokenConfigured = $map.Contains('FARM_WECHAT_CODE_PROVIDER_TOKEN') -and ([string]$map['FARM_WECHAT_CODE_PROVIDER_TOKEN']).Length -ge 24
            $snapshot.providerAutoRefreshConfigured = $map.Contains('FARM_WECHAT_CODE_AUTO_REFRESH') -and ([string]$map['FARM_WECHAT_CODE_AUTO_REFRESH']).Trim().ToLowerInvariant() -notin @('0','false','off','no')
        }
        catch {}
    }

    if ($snapshot.appDirectory) {
        $snapshot.accountsFile = Join-Path $snapshot.appDirectory 'data\accounts.json'
    }
    return [pscustomobject]$snapshot
}

function Read-WeChatAccounts {
    param([string]$AccountsFile)
    $result = [ordered]@{
        readable = $false
        totalAccounts = 0
        wechatAccounts = @()
        configuredWechatCount = 0
    }
    if (-not $AccountsFile -or -not (Test-Path -LiteralPath $AccountsFile)) { return [pscustomobject]$result }
    try {
        $raw = Get-Content -LiteralPath $AccountsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $accounts = if ($raw.accounts) { @($raw.accounts) } elseif ($raw -is [System.Array]) { @($raw) } else { @() }
        $result.readable = $true
        $result.totalAccounts = $accounts.Count
        $rows = New-Object System.Collections.ArrayList
        foreach ($account in $accounts) {
            $platform = if ($account.platform) { [string]$account.platform } else { 'qq' }
            if ($platform.ToLowerInvariant() -ne 'wx') { continue }
            $mode = if ($account.codeRefreshMode) { [string]$account.codeRefreshMode } else { '' }
            $configured = ($account.codeRefreshEnabled -eq $true) -and ($mode.ToLowerInvariant() -in @('windows_wechat','windows_session'))
            $codeLength = 0
            if ($account.code) { $codeLength = ([string]$account.code).Length }
            [void]$rows.Add([pscustomobject]@{
                id = [string]$account.id
                name = [string]$account.name
                platform = 'wx'
                codeRefreshEnabled = ($account.codeRefreshEnabled -eq $true)
                codeRefreshMode = $mode
                configured = $configured
                codeLength = $codeLength
                lastCodeRefreshAt = if ($account.lastCodeRefreshAt) { [long]$account.lastCodeRefreshAt } else { 0 }
                lastCodeRefreshOk = if ($null -ne $account.lastCodeRefreshOk) { [bool]$account.lastCodeRefreshOk } else { $null }
                lastCodeRefreshReason = if ($account.lastCodeRefreshReason) { [string]$account.lastCodeRefreshReason } else { '' }
                lastCodeSource = if ($account.lastCodeSource) { [string]$account.lastCodeSource } else { '' }
                wechatAppId = if ($account.wechatAppId) { [string]$account.wechatAppId } else { '' }
            })
        }
        $result.wechatAccounts = @($rows)
        $result.configuredWechatCount = @($rows | Where-Object { $_.configured }).Count
    }
    catch {}
    return [pscustomobject]$result
}

function Test-AgentHealth {
    $token = Get-SafeMachineEnv -Name 'FARM_WECHAT_CODE_PROVIDER_TOKEN'
    $url = Get-SafeMachineEnv -Name 'FARM_WECHAT_CODE_PROVIDER_URL'
    if ([string]::IsNullOrWhiteSpace($url)) { $url = 'http://127.0.0.1:43201/' }
    $result = [ordered]@{
        reachable = $false
        available = $false
        reason = ''
        endpoint = $url
        appId = ''
        wmpfVersion = 0
        clientVersion = ''
        residentState = ''
    }
    if ($token.Length -lt 24) {
        $result.reason = 'machine_provider_token_missing'
        return [pscustomobject]$result
    }
    try {
        $base = [Uri]$url
        $healthUri = [Uri]::new($base, 'v1/health')
        $headers = @{ Authorization = "Bearer $token"; 'Cache-Control' = 'no-store' }
        $health = Invoke-RestMethod -Uri $healthUri.AbsoluteUri -Headers $headers -Method Get -TimeoutSec 12
        $result.reachable = $true
        $result.available = ($health.ok -eq $true -and $health.available -eq $true)
        $result.reason = if ($health.reason) { [string]$health.reason } elseif ($result.available) { 'ok' } else { 'not_ready' }
        $result.appId = if ($health.appId) { [string]$health.appId } else { '' }
        $result.wmpfVersion = if ($health.wmpfVersion) { [int]$health.wmpfVersion } else { 0 }
        $result.clientVersion = if ($health.clientVersion) { [string]$health.clientVersion } else { '' }
        $result.residentState = if ($health.residentState) { [string]$health.residentState } else { '' }
    }
    catch {
        $result.reason = 'agent_health_unreachable'
    }
    return [pscustomobject]$result
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 Production Readiness Check' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host 'READ ONLY: no service restart, no worker stop/start, no Code refresh.' -ForegroundColor DarkGray
Write-Host 'Raw Code and Provider token are never printed or written to this report.' -ForegroundColor DarkGray
Write-Host ''

$agent = Test-AgentHealth
$service = Read-ServiceSnapshot -Name $ServiceName
$accounts = Read-WeChatAccounts -AccountsFile $service.accountsFile
$currentGit = Get-GitSnapshot -Root $projectRoot
$serviceGitRoot = if ($service.appDirectory) { Split-Path -Parent $service.appDirectory } else { '' }
$serviceGit = Get-GitSnapshot -Root $serviceGitRoot

$machineUrl = Get-SafeMachineEnv -Name 'FARM_WECHAT_CODE_PROVIDER_URL'
$machineToken = Get-SafeMachineEnv -Name 'FARM_WECHAT_CODE_PROVIDER_TOKEN'
$machineConfig = [ordered]@{
    providerUrlPresent = -not [string]::IsNullOrWhiteSpace($machineUrl)
    providerTokenPresent = $machineToken.Length -ge 24
}

$serviceUsesCurrentWorktree = $false
if ($service.appDirectory) {
    try {
        $serviceUsesCurrentWorktree = ([System.IO.Path]::GetFullPath($service.appDirectory).TrimEnd('\') -ieq (Join-Path $projectRoot 'core').TrimEnd('\'))
    }
    catch {}
}

$summary = [ordered]@{
    agentReady = ($agent.available -eq $true -and $agent.appId -eq 'wx5306c5978fdb76e4')
    serviceFound = ($service.found -eq $true)
    serviceAccountsReadable = ($accounts.readable -eq $true)
    configuredWechatAccounts = [int]$accounts.configuredWechatCount
    hasConfiguredWechatAccount = ([int]$accounts.configuredWechatCount -gt 0)
    serviceUsesCurrentWorktree = $serviceUsesCurrentWorktree
    serviceTrackedTreeClean = if ($serviceGit.available) { -not [bool]$serviceGit.trackedDirty } else { $null }
    machineProviderConfigPresent = ($machineConfig.providerUrlPresent -and $machineConfig.providerTokenPresent)
    serviceProviderEnvPresent = ($service.providerUrlConfigured -and $service.providerTokenConfigured)
    safeToPlanServiceRestart = $false
}
$summary.safeToPlanServiceRestart = $summary.agentReady -and $summary.serviceFound -and $summary.serviceAccountsReadable -and $summary.hasConfiguredWechatAccount -and ($summary.serviceTrackedTreeClean -ne $false)

$report = [ordered]@{
    version = 1
    phase = 'wechat-p8-production-readiness-readonly'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    safety = [ordered]@{
        readOnly = $true
        serviceRestarted = $false
        workerStopped = $false
        workerStarted = $false
        wxLoginCalled = $false
        rawCodePrinted = $false
        rawCodePersistedInReport = $false
        providerTokenPrinted = $false
        providerTokenPersistedInReport = $false
    }
    agent = $agent
    machineConfig = $machineConfig
    service = $service
    accounts = $accounts
    currentWorktree = $currentGit
    serviceWorktree = $serviceGit
    summary = $summary
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-production-readiness-{0}.json" -f (Get-Timestamp))
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ("Agent ready: {0} ({1})" -f $summary.agentReady, $agent.reason)
Write-Host ("Service {0}: {1} / {2}" -f $ServiceName, $service.found, $service.status)
Write-Host ("Service AppDirectory: {0}" -f $(if ($service.appDirectory) { $service.appDirectory } else { '(unknown)' }))
Write-Host ("Service uses current probe worktree: {0}" -f $summary.serviceUsesCurrentWorktree)
Write-Host ("Service tracked tree clean: {0}" -f $summary.serviceTrackedTreeClean)
Write-Host ("Saved WeChat accounts: {0}; configured for resident recovery: {1}" -f @($accounts.wechatAccounts).Count, $accounts.configuredWechatCount)
foreach ($row in @($accounts.wechatAccounts)) {
    Write-Host ("  wx account id={0} name={1} configured={2} mode={3} codeLen={4}" -f $row.id, $row.name, $row.configured, $row.codeRefreshMode, $row.codeLength)
}
Write-Host ("Machine Provider config present: {0}" -f $summary.machineProviderConfigPresent)
Write-Host ("FAR2Farm NSSM Provider env present: {0}" -f $summary.serviceProviderEnvPresent)
Write-Host ("Safe to plan service restart: {0}" -f $summary.safeToPlanServiceRestart)
Write-Host ''
Write-Host 'Report path:'
Write-Host $reportPath

if ($summary.safeToPlanServiceRestart) {
    Write-Host ''
    Write-Host 'P8 readiness: PASS (read-only). Do not restart FAR2Farm manually yet.' -ForegroundColor Green
    exit 0
}

Write-Host ''
Write-Host 'P8 readiness: NEEDS NEXT FIX. Do not restart FAR2Farm manually yet.' -ForegroundColor Yellow
exit 2
