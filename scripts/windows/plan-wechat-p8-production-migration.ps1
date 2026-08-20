param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$auditBase = Join-Path $env:LOCALAPPDATA 'FAR2\p8-production-audit'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$auditRoot = Join-Path $auditBase $stamp
$candidateRoot = Join-Path $auditRoot 'candidate'

$runtimeFiles = @(
    'core/client.js',
    'core/src/core/worker-bootstrap.js',
    'core/src/services/wechat-gateway-profile.js',
    'core/src/services/wechat-runtime-code-provider.js',
    'core/src/services/wechat-recovery-manager.js'
)

function Get-GitExe {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { throw 'git was not found.' }
    return [string]$git.Source
}

function Get-ServiceConfig {
    param([string]$Name)
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (-not (Test-Path -LiteralPath $key)) { throw "NSSM service parameters key not found: $key" }
    $props = Get-ItemProperty -Path $key -ErrorAction Stop
    $appDirectory = [string]$props.AppDirectory
    if ([string]::IsNullOrWhiteSpace($appDirectory)) { throw 'FAR2Farm AppDirectory is empty.' }

    $extra = @()
    if ($props.PSObject.Properties.Name -contains 'AppEnvironmentExtra') {
        $raw = $props.AppEnvironmentExtra
        if ($raw -is [System.Array]) { $extra = @($raw | ForEach-Object { [string]$_ }) }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$raw)) { $extra = @([string]$raw) }
    }
    $hasUrl = @($extra | Where-Object { $_ -like 'FARM_WECHAT_CODE_PROVIDER_URL=*' }).Count -gt 0
    $hasToken = @($extra | Where-Object { $_ -like 'FARM_WECHAT_CODE_PROVIDER_TOKEN=*' }).Count -gt 0

    return [pscustomobject]@{
        State = [string]$svc.State
        ProcessId = [int]$svc.ProcessId
        AppDirectory = [System.IO.Path]::GetFullPath($appDirectory)
        Application = [string]$props.Application
        AppParameters = [string]$props.AppParameters
        HasProviderUrlEnv = $hasUrl
        HasProviderTokenEnv = $hasToken
    }
}

function Get-GitSnapshot {
    param([string]$Root, [string]$Git)
    $head = (& $Git -C $Root rev-parse HEAD 2>$null).Trim()
    if (-not $head) { throw "Unable to read git HEAD: $Root" }
    $branch = (& $Git -C $Root branch --show-current 2>$null).Trim()
    $tracked = @(& $Git -C $Root status --porcelain --untracked-files=no 2>$null)
    return [pscustomobject]@{
        Head = $head
        Branch = $branch
        TrackedDirty = ($tracked.Count -gt 0)
    }
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-GitObjectPath {
    param([string]$Git, [string]$Root, [string]$Commit, [string]$Rel)
    & $Git -C $Root cat-file -e ("{0}:{1}" -f $Commit, $Rel) 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Export-GitFile {
    param([string]$Git, [string]$Root, [string]$Commit, [string]$Rel, [string]$Destination)
    $parent = Split-Path -Parent $Destination
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $spec = "{0}:{1}" -f $Commit, $Rel
    $bytes = & $Git -C $Root show $spec 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git show failed: $spec" }
    [IO.File]::WriteAllLines($Destination, @($bytes), [Text.UTF8Encoding]::new($false))
}

function Get-PathStatus {
    param([string]$Git, [string]$Root, [string]$Rel)
    return (@(& $Git -C $Root status --porcelain --untracked-files=all -- $Rel 2>$null) -join "`n")
}

function Test-AgentHealth {
    $token = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
    $url = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', 'Machine')
    if ([string]::IsNullOrWhiteSpace($url)) { $url = 'http://127.0.0.1:43201/' }
    if ($token.Length -lt 24) {
        return [pscustomobject]@{ Available=$false; Reason='machine_provider_token_missing'; AppId=''; ClientVersion='' }
    }
    try {
        $endpoint = ([Uri]::new([Uri]$url, 'v1/health')).AbsoluteUri
        $headers = @{ Authorization = "Bearer $token"; Accept='application/json'; 'Cache-Control'='no-store' }
        $res = Invoke-RestMethod -Method Get -Uri $endpoint -Headers $headers -TimeoutSec 8
        return [pscustomobject]@{
            Available = ($res.ok -eq $true -and $res.available -eq $true)
            Reason = if ($res.reason) { [string]$res.reason } else { if ($res.available -eq $true) { 'ok' } else { 'not_ready' } }
            AppId = [string]$res.appId
            ClientVersion = [string]$res.clientVersion
        }
    }
    catch {
        return [pscustomobject]@{ Available=$false; Reason='provider_health_failed'; AppId=''; ClientVersion='' }
    }
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 Production Migration Audit' -ForegroundColor Cyan
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host 'READ ONLY: this audit does not stop/restart FAR2Farm and does not modify the production worktree/data.' -ForegroundColor DarkGray
Write-Host 'It performs a three-way merge simulation for only the P8 runtime-critical files.' -ForegroundColor DarkGray
Write-Host ''

$git = Get-GitExe
$source = Get-GitSnapshot -Root $projectRoot -Git $git
$service = Get-ServiceConfig -Name $ServiceName
if ($service.State -ne 'Running') { throw "Production service $ServiceName is not Running." }
$productionRoot = Split-Path -Parent $service.AppDirectory
$production = Get-GitSnapshot -Root $productionRoot -Git $git

$mergeBase = (& $git -C $projectRoot merge-base $production.Head $source.Head 2>$null).Trim()
if (-not $mergeBase) { throw 'Unable to determine merge-base between production HEAD and P8 source HEAD.' }

New-Item -ItemType Directory -Force -Path $candidateRoot | Out-Null
$results = @()
$conflicts = 0
$ready = 0
$already = 0

foreach ($rel in $runtimeFiles) {
    $sourcePath = Join-Path $projectRoot ($rel -replace '/', '\')
    $prodPath = Join-Path $productionRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "P8 source file missing: $rel" }

    $sourceHash = Get-FileSha256 -Path $sourcePath
    $prodExists = Test-Path -LiteralPath $prodPath -PathType Leaf
    $prodHash = if ($prodExists) { Get-FileSha256 -Path $prodPath } else { '' }
    $statusText = Get-PathStatus -Git $git -Root $productionRoot -Rel $rel
    $baseExists = Test-GitObjectPath -Git $git -Root $projectRoot -Commit $mergeBase -Rel $rel
    $prodHeadExists = Test-GitObjectPath -Git $git -Root $projectRoot -Commit $production.Head -Rel $rel

    $classification = ''
    $mergeClean = $false
    $candidatePath = ''

    if ($prodExists -and $prodHash -eq $sourceHash) {
        $classification = 'already_integrated'
        $mergeClean = $true
        $already++
    }
    elseif (-not $baseExists) {
        if (-not $prodExists -and -not $prodHeadExists) {
            $classification = 'new_file_ready'
            $mergeClean = $true
            $candidatePath = Join-Path $candidateRoot ($rel -replace '/', '\')
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $candidatePath) | Out-Null
            Copy-Item -LiteralPath $sourcePath -Destination $candidatePath -Force
            $ready++
        }
        else {
            $classification = 'conflict_existing_without_common_base'
            $conflicts++
        }
    }
    elseif (-not $prodExists) {
        $classification = 'conflict_production_file_missing'
        $conflicts++
    }
    else {
        $basePath = Join-Path $auditRoot ('base\' + ($rel -replace '/', '\'))
        Export-GitFile -Git $git -Root $projectRoot -Commit $mergeBase -Rel $rel -Destination $basePath
        $candidatePath = Join-Path $candidateRoot ($rel -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $candidatePath) | Out-Null

        $mergeOutput = @(& $git merge-file -p -- $prodPath $basePath $sourcePath 2>$null)
        $mergeExit = $LASTEXITCODE
        [IO.File]::WriteAllLines($candidatePath, $mergeOutput, [Text.UTF8Encoding]::new($false))

        if ($mergeExit -eq 0) {
            $mergeClean = $true
            $candidateHash = Get-FileSha256 -Path $candidatePath
            if ($candidateHash -eq $prodHash) {
                $classification = 'already_effective_after_merge'
                $already++
            }
            else {
                $classification = if ([string]::IsNullOrWhiteSpace($statusText)) { 'clean_merge_ready' } else { 'dirty_local_clean_merge_ready' }
                $ready++
            }
        }
        else {
            $classification = 'three_way_merge_conflict'
            $conflicts++
        }
    }

    $results += [pscustomobject]@{
        path = $rel
        productionStatus = $statusText
        productionExists = $prodExists
        productionDirtyForFile = (-not [string]::IsNullOrWhiteSpace($statusText))
        baseExists = $baseExists
        sourceSha256 = $sourceHash
        productionSha256 = $prodHash
        classification = $classification
        mergeClean = $mergeClean
        candidateRelativePath = if ($candidatePath) { [IO.Path]::GetRelativePath($auditRoot, $candidatePath) } else { '' }
    }
}

$agent = Test-AgentHealth
$machineUrl = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', 'Machine')
$machineToken = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
$machineProviderConfigured = (-not [string]::IsNullOrWhiteSpace($machineUrl) -and $machineToken.Length -ge 24)
$nssmProviderConfigured = ($service.HasProviderUrlEnv -and $service.HasProviderTokenEnv)
$safeForNextApplyStep = ($conflicts -eq 0 -and $agent.Available -and $machineProviderConfigured)

$report = [ordered]@{
    version = 1
    phase = 'wechat-p8-production-migration-audit'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{
        worktree = $projectRoot
        head = $source.Head
        branch = $source.Branch
    }
    production = [ordered]@{
        serviceName = $ServiceName
        serviceState = $service.State
        servicePid = $service.ProcessId
        appDirectory = $service.AppDirectory
        worktree = $productionRoot
        head = $production.Head
        branch = $production.Branch
        trackedDirty = $production.TrackedDirty
    }
    mergeBase = $mergeBase
    provider = [ordered]@{
        residentAvailable = $agent.Available
        reason = $agent.Reason
        appId = $agent.AppId
        clientVersion = $agent.ClientVersion
        machineConfigPresent = $machineProviderConfigured
        nssmExplicitEnvPresent = $nssmProviderConfigured
        tokenPrinted = $false
    }
    files = $results
    summary = [ordered]@{
        runtimeCriticalFiles = $runtimeFiles.Count
        ready = $ready
        alreadyIntegrated = $already
        conflicts = $conflicts
        safeForNextApplyStep = $safeForNextApplyStep
        requiresNssmProviderEnvInjection = (-not $nssmProviderConfigured)
    }
    safety = [ordered]@{
        productionServiceRestarted = $false
        productionWorktreeModified = $false
        productionDataModified = $false
        productionAccountsModified = $false
        qqWorkersControlled = $false
        wxLoginCalled = $false
        rawCodePrinted = $false
        providerTokenPrinted = $false
    }
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-p8-production-migration-audit-{0}.json" -f $stamp)
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $auditRoot 'AUDIT.json') -Encoding UTF8

Write-Host ("Source P8 HEAD: {0}" -f $source.Head)
Write-Host ("Production HEAD: {0}" -f $production.Head)
Write-Host ("Production tracked dirty: {0}" -f $production.TrackedDirty)
Write-Host ("Merge base: {0}" -f $mergeBase)
Write-Host ("Resident Agent ready: {0} ({1})" -f $agent.Available, $agent.Reason)
Write-Host ("NSSM explicit Provider env present: {0}" -f $nssmProviderConfigured)
Write-Host ''
foreach ($item in $results) {
    Write-Host ("[{0}] {1}" -f $item.classification, $item.path)
}
Write-Host ''
Write-Host ("Ready/already/conflicts: {0}/{1}/{2}" -f $ready, $already, $conflicts)
Write-Host ("Safe for next apply step: {0}" -f $safeForNextApplyStep)
Write-Host ("NSSM Provider env injection required: {0}" -f (-not $nssmProviderConfigured))
Write-Host ''
Write-Host 'Audit workspace:'
Write-Host $auditRoot
Write-Host ''
Write-Host 'Report path:'
Write-Host $reportPath
Write-Host ''
Write-Host 'No production files or services were modified.' -ForegroundColor Green

if (-not $safeForNextApplyStep) {
    Write-Host 'P8 production migration audit needs conflict handling before any apply/restart.' -ForegroundColor Yellow
    exit 2
}

Write-Host 'P8 production migration audit PASSED. Do not restart FAR2Farm yet.' -ForegroundColor Green
exit 0
