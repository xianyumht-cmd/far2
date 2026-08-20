param([string]$ServiceName = 'FAR2Farm')

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'

function Get-Prop($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function Get-MachineEnv([string]$Name) {
    try { return [string][Environment]::GetEnvironmentVariable($Name, 'Machine') } catch { return '' }
}

function Get-GitSnapshot([string]$Root) {
    $out = [ordered]@{ available=$false; root=''; head=''; branch=''; trackedDirty=$null }
    if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return [pscustomobject]$out }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { return [pscustomobject]$out }
    try {
        $top = (& $git.Source -C $Root rev-parse --show-toplevel 2>$null).Trim()
        if (-not $top) { return [pscustomobject]$out }
        $out.available = $true
        $out.root = [IO.Path]::GetFullPath($top)
        $out.head = (& $git.Source -C $Root rev-parse HEAD 2>$null).Trim()
        $out.branch = (& $git.Source -C $Root branch --show-current 2>$null).Trim()
        $dirty = @(& $git.Source -C $Root status --porcelain --untracked-files=no 2>$null)
        $out.trackedDirty = ($dirty.Count -gt 0)
    } catch {}
    return [pscustomobject]$out
}

function Get-ServiceSnapshot([string]$Name) {
    $out = [ordered]@{
        found=$false; status='Missing'; appDirectory=''; application=''; appParameters='';
        providerUrlConfigured=$false; providerTokenConfigured=$false; providerAutoRefreshConfigured=$false; accountsFile=''
    }
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { return [pscustomobject]$out }
    $out.found = $true
    $out.status = [string]$svc.Status
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (Test-Path -LiteralPath $key) {
        try {
            $p = Get-ItemProperty -Path $key -ErrorAction Stop
            $out.appDirectory = [string](Get-Prop $p 'AppDirectory' '')
            $out.application = [string](Get-Prop $p 'Application' '')
            $out.appParameters = [string](Get-Prop $p 'AppParameters' '')
            $map = @{}
            foreach ($entry in @(Get-Prop $p 'AppEnvironmentExtra' @())) {
                $text = [string]$entry; $idx = $text.IndexOf('=')
                if ($idx -gt 0) { $map[$text.Substring(0,$idx)] = $text.Substring($idx+1) }
            }
            $out.providerUrlConfigured = $map.ContainsKey('FARM_WECHAT_CODE_PROVIDER_URL') -and -not [string]::IsNullOrWhiteSpace([string]$map['FARM_WECHAT_CODE_PROVIDER_URL'])
            $out.providerTokenConfigured = $map.ContainsKey('FARM_WECHAT_CODE_PROVIDER_TOKEN') -and ([string]$map['FARM_WECHAT_CODE_PROVIDER_TOKEN']).Length -ge 24
            $auto = if ($map.ContainsKey('FARM_WECHAT_CODE_AUTO_REFRESH')) { ([string]$map['FARM_WECHAT_CODE_AUTO_REFRESH']).Trim().ToLowerInvariant() } else { '' }
            $out.providerAutoRefreshConfigured = $auto -and $auto -notin @('0','false','off','no')
        } catch {}
    }
    if ($out.appDirectory) { $out.accountsFile = Join-Path $out.appDirectory 'data\accounts.json' }
    return [pscustomobject]$out
}

function Get-WeChatAccounts([string]$AccountsFile) {
    $out = [ordered]@{ readable=$false; totalAccounts=0; wechatAccounts=@(); configuredWechatCount=0 }
    if (-not $AccountsFile -or -not (Test-Path -LiteralPath $AccountsFile)) { return [pscustomobject]$out }
    try {
        $raw = Get-Content -LiteralPath $AccountsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $rawAccounts = Get-Prop $raw 'accounts' $null
        $accounts = if ($null -ne $rawAccounts) { @($rawAccounts) } elseif ($raw -is [Array]) { @($raw) } else { @() }
        $rows = @()
        foreach ($a in $accounts) {
            $platform = [string](Get-Prop $a 'platform' 'qq')
            if ($platform.ToLowerInvariant() -ne 'wx') { continue }
            $mode = [string](Get-Prop $a 'codeRefreshMode' '')
            $enabled = (Get-Prop $a 'codeRefreshEnabled' $false) -eq $true
            $configured = $enabled -and $mode.ToLowerInvariant() -in @('windows_wechat','windows_session')
            $code = [string](Get-Prop $a 'code' '')
            $lastOkRaw = Get-Prop $a 'lastCodeRefreshOk' $null
            $rows += [pscustomobject]@{
                id=[string](Get-Prop $a 'id' ''); name=[string](Get-Prop $a 'name' ''); platform='wx';
                codeRefreshEnabled=$enabled; codeRefreshMode=$mode; configured=$configured; codeLength=$code.Length;
                lastCodeRefreshAt=[long](Get-Prop $a 'lastCodeRefreshAt' 0);
                lastCodeRefreshOk=if ($null -eq $lastOkRaw) { $null } else { [bool]$lastOkRaw };
                lastCodeRefreshReason=[string](Get-Prop $a 'lastCodeRefreshReason' '');
                lastCodeSource=[string](Get-Prop $a 'lastCodeSource' '');
                wechatAppId=[string](Get-Prop $a 'wechatAppId' '')
            }
        }
        $out.readable = $true; $out.totalAccounts = $accounts.Count; $out.wechatAccounts = @($rows)
        $out.configuredWechatCount = @($rows | Where-Object { $_.configured }).Count
    } catch {}
    return [pscustomobject]$out
}

function Get-AgentHealth {
    $token = Get-MachineEnv 'FARM_WECHAT_CODE_PROVIDER_TOKEN'
    $url = Get-MachineEnv 'FARM_WECHAT_CODE_PROVIDER_URL'
    if ([string]::IsNullOrWhiteSpace($url)) { $url = 'http://127.0.0.1:43201/' }
    $out = [ordered]@{ reachable=$false; available=$false; reason=''; endpoint=$url; appId=''; wmpfVersion=0; clientVersion=''; residentState='' }
    if ($token.Length -lt 24) { $out.reason='machine_provider_token_missing'; return [pscustomobject]$out }
    try {
        $uri = [Uri]::new([Uri]$url, 'v1/health').AbsoluteUri
        $h = Invoke-RestMethod -Uri $uri -Method Get -Headers @{ Authorization="Bearer $token"; 'Cache-Control'='no-store' } -TimeoutSec 12
        $out.reachable = $true; $out.available = ((Get-Prop $h 'ok' $false) -eq $true -and (Get-Prop $h 'available' $false) -eq $true)
        $out.reason = [string](Get-Prop $h 'reason' $(if ($out.available) {'ok'} else {'not_ready'}))
        $out.appId = [string](Get-Prop $h 'appId' ''); $out.wmpfVersion = [int](Get-Prop $h 'wmpfVersion' 0)
        $out.clientVersion = [string](Get-Prop $h 'clientVersion' ''); $out.residentState = [string](Get-Prop $h 'residentState' '')
    } catch { $out.reason='agent_health_unreachable' }
    return [pscustomobject]$out
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 Production Readiness Check' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host 'READ ONLY: no service restart, no worker stop/start, no Code refresh.' -ForegroundColor DarkGray
Write-Host 'Raw Code and Provider token are never printed or written to this report.' -ForegroundColor DarkGray
Write-Host ''

$agent = Get-AgentHealth
$service = Get-ServiceSnapshot $ServiceName
$accounts = Get-WeChatAccounts $service.accountsFile
$currentGit = Get-GitSnapshot $projectRoot
$serviceRoot = if ($service.appDirectory) { Split-Path -Parent $service.appDirectory } else { '' }
$serviceGit = Get-GitSnapshot $serviceRoot
$machineUrl = Get-MachineEnv 'FARM_WECHAT_CODE_PROVIDER_URL'
$machineToken = Get-MachineEnv 'FARM_WECHAT_CODE_PROVIDER_TOKEN'
$machineConfig = [ordered]@{ providerUrlPresent= -not [string]::IsNullOrWhiteSpace($machineUrl); providerTokenPresent=($machineToken.Length -ge 24) }

$usesCurrent = $false
if ($service.appDirectory) { try { $usesCurrent = ([IO.Path]::GetFullPath($service.appDirectory).TrimEnd('\') -ieq (Join-Path $projectRoot 'core').TrimEnd('\')) } catch {} }
$trackedClean = if ($serviceGit.available) { -not [bool]$serviceGit.trackedDirty } else { $null }
$summary = [ordered]@{
    agentReady=($agent.available -and $agent.appId -eq 'wx5306c5978fdb76e4'); serviceFound=$service.found;
    serviceAccountsReadable=$accounts.readable; configuredWechatAccounts=[int]$accounts.configuredWechatCount;
    hasConfiguredWechatAccount=([int]$accounts.configuredWechatCount -gt 0); serviceUsesCurrentWorktree=$usesCurrent;
    serviceTrackedTreeClean=$trackedClean; machineProviderConfigPresent=($machineConfig.providerUrlPresent -and $machineConfig.providerTokenPresent);
    serviceProviderEnvPresent=($service.providerUrlConfigured -and $service.providerTokenConfigured); safeToPlanServiceRestart=$false
}
$summary.safeToPlanServiceRestart = $summary.agentReady -and $summary.serviceFound -and $summary.serviceAccountsReadable -and $summary.hasConfiguredWechatAccount -and ($summary.serviceTrackedTreeClean -ne $false)

$report = [ordered]@{
    version=2; phase='wechat-p8-production-readiness-readonly'; generatedAt=(Get-Date).ToUniversalTime().ToString('o');
    safety=[ordered]@{readOnly=$true;serviceRestarted=$false;workerStopped=$false;workerStarted=$false;wxLoginCalled=$false;rawCodePrinted=$false;rawCodePersistedInReport=$false;providerTokenPrinted=$false;providerTokenPersistedInReport=$false};
    agent=$agent; machineConfig=$machineConfig; service=$service; accounts=$accounts; currentWorktree=$currentGit; serviceWorktree=$serviceGit; summary=$summary
}
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-production-readiness-{0}.json" -f (Get-Date).ToString('yyyyMMdd-HHmmss'))
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ("Agent ready: {0} ({1})" -f $summary.agentReady, $agent.reason)
Write-Host ("Service {0}: {1} / {2}" -f $ServiceName, $service.found, $service.status)
Write-Host ("Service AppDirectory: {0}" -f $(if ($service.appDirectory) {$service.appDirectory} else {'(unknown)'}))
Write-Host ("Service uses current probe worktree: {0}" -f $summary.serviceUsesCurrentWorktree)
Write-Host ("Service tracked tree clean: {0}" -f $summary.serviceTrackedTreeClean)
Write-Host ("Saved WeChat accounts: {0}; configured for resident recovery: {1}" -f @($accounts.wechatAccounts).Count, $accounts.configuredWechatCount)
foreach ($row in @($accounts.wechatAccounts)) { Write-Host ("  wx account id={0} name={1} configured={2} mode={3} codeLen={4}" -f $row.id,$row.name,$row.configured,$row.codeRefreshMode,$row.codeLength) }
Write-Host ("Machine Provider config present: {0}" -f $summary.machineProviderConfigPresent)
Write-Host ("FAR2Farm NSSM Provider env present: {0}" -f $summary.serviceProviderEnvPresent)
Write-Host ("Safe to plan service restart: {0}" -f $summary.safeToPlanServiceRestart)
Write-Host ''; Write-Host 'Report path:'; Write-Host $reportPath
if ($summary.safeToPlanServiceRestart) { Write-Host ''; Write-Host 'P8 readiness: PASS (read-only). Do not restart FAR2Farm manually yet.' -ForegroundColor Green; exit 0 }
Write-Host ''; Write-Host 'P8 readiness: NEEDS NEXT FIX. Do not restart FAR2Farm manually yet.' -ForegroundColor Yellow; exit 2
