param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$backupBase = Join-Path $env:LOCALAPPDATA 'FAR2\p8-production-backup'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupRoot = Join-Path $backupBase $stamp
$runtimeFiles = @(
    'core/client.js',
    'core/src/core/worker-bootstrap.js',
    'core/src/services/wechat-gateway-profile.js',
    'core/src/services/wechat-runtime-code-provider.js',
    'core/src/services/wechat-recovery-manager.js'
)
$expectedAppId = 'wx5306c5978fdb76e4'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-GitExe {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { throw 'git was not found.' }
    return [string]$git.Source
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-GitHead {
    param([string]$Git, [string]$Root)
    $output = @(& $Git -C $Root rev-parse HEAD 2>$null)
    if ($output.Count -eq 0 -or $null -eq $output[0]) { return '' }
    return ([string]$output[0]).Trim()
}

function Get-TrackedStatus {
    param([string]$Git, [string]$Root)
    return @(& $Git -C $Root status --porcelain --untracked-files=no 2>$null)
}

function Get-ServiceConfig {
    param([string]$Name)
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (-not (Test-Path -LiteralPath $key)) { throw "NSSM service parameters key not found: $key" }
    $props = Get-ItemProperty -Path $key -ErrorAction Stop
    $appDirectory = [string]$props.AppDirectory
    if ([string]::IsNullOrWhiteSpace($appDirectory)) { throw 'FAR2Farm AppDirectory is empty.' }

    $hasExtra = $props.PSObject.Properties.Name -contains 'AppEnvironmentExtra'
    $extra = @()
    if ($hasExtra) {
        $raw = $props.AppEnvironmentExtra
        if ($raw -is [System.Array]) { $extra = @($raw | ForEach-Object { [string]$_ }) }
        elseif (-not [string]::IsNullOrWhiteSpace([string]$raw)) { $extra = @([string]$raw) }
    }

    return [pscustomobject]@{
        State = [string]$svc.State
        ProcessId = [int]$svc.ProcessId
        AppDirectory = [IO.Path]::GetFullPath($appDirectory)
        Application = [string]$props.Application
        AppParameters = [string]$props.AppParameters
        RegistryKey = $key
        HadAppEnvironmentExtra = $hasExtra
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

function Get-LatestReport {
    param([string]$Pattern, [scriptblock]$Predicate)
    if (-not (Test-Path -LiteralPath $reportRoot)) { return $null }
    $files = @(Get-ChildItem -LiteralPath $reportRoot -Filter $Pattern -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    foreach ($file in $files) {
        try {
            $data = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if (& $Predicate $data) {
                return [pscustomobject]@{ Path=$file.FullName; Data=$data }
            }
        }
        catch { continue }
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

function Set-NssmEnvironmentExtra {
    param([string]$RegistryKey, [string[]]$Values)
    New-ItemProperty -Path $RegistryKey -Name 'AppEnvironmentExtra' -PropertyType MultiString -Value ([string[]]$Values) -Force | Out-Null
}

function Restore-NssmEnvironmentExtra {
    param([object]$Service)
    if ($Service.HadAppEnvironmentExtra) {
        Set-NssmEnvironmentExtra -RegistryKey $Service.RegistryKey -Values ([string[]]$Service.AppEnvironmentExtra)
    }
    else {
        Remove-ItemProperty -Path $Service.RegistryKey -Name 'AppEnvironmentExtra' -ErrorAction SilentlyContinue
    }
}

function Wait-ServiceRunning {
    param([string]$Name, [int]$OldPid = 0, [int]$TimeoutSec = 50)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $last = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
        if ($last -and [string]$last.State -eq 'Running' -and [int]$last.ProcessId -gt 0) {
            if ($OldPid -le 0 -or [int]$last.ProcessId -ne $OldPid) { return $last }
        }
        Start-Sleep -Milliseconds 500
    }
    return $last
}

function Write-Report {
    param([hashtable]$Report, [string]$Path)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 Controlled Production Apply' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host 'This step modifies only 5 audited runtime files + FAR2Farm Provider env, then restarts FAR2Farm once.' -ForegroundColor DarkGray
Write-Host 'Production data/accounts are not edited. A failure after mutation triggers automatic rollback.' -ForegroundColor DarkGray
Write-Host 'The deployment restart will naturally restart FAR2Farm-owned QQ workers; scoped QQ isolation is verified in the later recovery gate.' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-IsAdministrator)) {
    throw 'Administrator elevation is required before controlled production apply. No production change was made.'
}

$git = Get-GitExe
$service = Get-ServiceConfig -Name $ServiceName
if ($service.State -ne 'Running' -or $service.ProcessId -le 0) { throw "Production service $ServiceName is not Running." }
$productionCore = $service.AppDirectory
$productionRoot = Split-Path -Parent $productionCore
$productionHead = Get-GitHead -Git $git -Root $productionRoot
if (-not $productionHead) { throw 'Unable to read production git HEAD.' }

$resolution = Get-LatestReport -Pattern 'wechat-p8-client-resolution-audit-*.json' -Predicate {
    param($r)
    return [string]$r.phase -eq 'wechat-p8-production-client-semantic-resolution-audit' -and $r.readyForControlledApply -eq $true
}
if (-not $resolution) { throw 'No successful P8 client semantic-resolution audit report was found.' }
$resolutionData = $resolution.Data

$migration = Get-LatestReport -Pattern 'wechat-p8-production-migration-audit-*.json' -Predicate {
    param($r)
    return [string]$r.phase -eq 'wechat-p8-production-migration-audit' -and [int]$r.summary.conflicts -eq 1
}
if (-not $migration) { throw 'No matching P8 production migration audit report was found.' }
$migrationData = $migration.Data

if ([string]$resolutionData.production.worktree -ne $productionRoot) { throw 'Production worktree no longer matches the successful resolution audit.' }
if ([string]$resolutionData.production.head -ne $productionHead) { throw 'Production HEAD changed after the successful resolution audit. Re-run audits first.' }
if ([string]$migrationData.production.head -ne $productionHead) { throw 'Production HEAD no longer matches the migration audit.' }

$candidateRoot = [string]$resolutionData.candidate.root
if (-not (Test-Path -LiteralPath $candidateRoot -PathType Container)) { throw "Resolved candidate workspace is missing: $candidateRoot" }

$productionClient = Join-Path $productionRoot 'core\client.js'
$prodClientStatus = @(& $git -C $productionRoot status --porcelain --untracked-files=no -- core/client.js 2>$null)
if ($prodClientStatus.Count -gt 0) { throw 'Production core/client.js changed after resolution audit. Refusing controlled apply.' }
$prodClientHash = Get-FileSha256 -Path $productionClient
$expectedProdClientHash = [string]$resolutionData.production.clientSha256Before
if ($prodClientHash -ne $expectedProdClientHash) { throw 'Production core/client.js hash changed after resolution audit.' }

$candidateHashes = @{}
foreach ($rel in $runtimeFiles) {
    $candidatePath = Join-Path $candidateRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { throw "Audited candidate file is missing: $rel" }
    $candidateHashes[$rel] = Get-FileSha256 -Path $candidatePath
}
if ($candidateHashes['core/client.js'] -ne [string]$resolutionData.candidate.clientSha256) {
    throw 'Audited client.js candidate changed after the resolution audit.'
}

foreach ($rel in $runtimeFiles | Where-Object { $_ -ne 'core/client.js' }) {
    $entry = @($migrationData.files | Where-Object { [string]$_.path -eq $rel }) | Select-Object -First 1
    if (-not $entry) { throw "Migration audit entry missing: $rel" }
    if ([string]$entry.classification -ne 'new_file_ready') { throw "Migration audit no longer authorizes new runtime file: $rel" }
    if ($candidateHashes[$rel] -ne [string]$entry.sourceSha256) { throw "Candidate hash differs from migration audit: $rel" }
    $prodPath = Join-Path $productionRoot ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $prodPath) { throw "Production path appeared after audit; refusing overwrite: $rel" }
}

$accountsPath = Join-Path $productionCore 'data\accounts.json'
if (-not (Test-Path -LiteralPath $accountsPath -PathType Leaf)) { throw 'Production accounts.json is missing.' }
$accountsHashBefore = Get-FileSha256 -Path $accountsPath
$trackedStatusBefore = @(Get-TrackedStatus -Git $git -Root $productionRoot)

$machineUrl = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', 'Machine')
$machineToken = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
if ([string]::IsNullOrWhiteSpace($machineUrl) -or $machineToken.Length -lt 24) { throw 'Machine WeChat Provider URL/token are not configured.' }
$agentBefore = Test-AgentHealth -Url $machineUrl -Token $machineToken
if (-not $agentBefore.Available -or $agentBefore.AppId -ne $expectedAppId) { throw "Resident Agent is not ready: $($agentBefore.Reason)" }

$node = Find-NodeExe -Service $service
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupClient = Join-Path $backupRoot 'core\client.js'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupClient) | Out-Null
Copy-Item -LiteralPath $productionClient -Destination $backupClient -Force
$backupAccounts = Join-Path $backupRoot 'data\accounts.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupAccounts) | Out-Null
Copy-Item -LiteralPath $accountsPath -Destination $backupAccounts -Force

$reportPath = Join-Path $reportRoot ("wechat-p8-production-apply-{0}.json" -f $stamp)
$report = [ordered]@{
    version = 1
    phase = 'wechat-p8-controlled-production-apply'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{
        resolutionReport = $resolution.Path
        migrationReport = $migration.Path
        candidateRoot = $candidateRoot
    }
    production = [ordered]@{
        serviceName = $ServiceName
        worktree = $productionRoot
        appDirectory = $productionCore
        head = $productionHead
        servicePidBefore = $service.ProcessId
        servicePidAfter = 0
        accountsSha256Before = $accountsHashBefore
        accountsSha256After = ''
        accountsUnchanged = $false
        trackedDirtyBefore = ($trackedStatusBefore.Count -gt 0)
    }
    provider = [ordered]@{
        residentReadyBefore = $agentBefore.Available
        residentReadyAfter = $false
        appId = $agentBefore.AppId
        clientVersion = $agentBefore.ClientVersion
        machineConfigPresent = $true
        nssmEnvInjected = $false
        tokenPrinted = $false
    }
    apply = [ordered]@{
        backupRoot = $backupRoot
        filesApplied = @()
        syntaxPreflightPassed = $false
        dependencyPreflightPassed = $false
        serviceRestartAttempted = $false
        serviceRunningStable = $false
    }
    rollback = [ordered]@{
        attempted = $false
        succeeded = $false
        reason = ''
    }
    safety = [ordered]@{
        productionAccountsEdited = $false
        rawCodePrinted = $false
        providerTokenPrinted = $false
        wxLoginCalledByApply = $false
        farmWritesAddedByApply = $false
        gitResetCheckoutCleanUsed = $false
    }
    gatePassed = $false
}

$manifest = [ordered]@{
    version = 1
    productionHead = $productionHead
    productionClientSha256 = $prodClientHash
    accountsSha256 = $accountsHashBefore
    candidateHashes = $candidateHashes
    note = 'Provider credentials are intentionally not stored in this backup manifest.'
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $backupRoot 'BACKUP-MANIFEST.json') -Encoding UTF8

$mutated = $false
$restartAttempted = $false
$oldEnvironmentExtra = [string[]]$service.AppEnvironmentExtra
$oldHadEnvironmentExtra = [bool]$service.HadAppEnvironmentExtra

try {
    Write-Host ("Production service: {0} / PID {1}" -f $ServiceName, $service.ProcessId)
    Write-Host ("Production HEAD: {0}" -f $productionHead)
    Write-Host ("Resident Agent ready: {0} ({1})" -f $agentBefore.Available, $agentBefore.Reason)
    Write-Host ("Audited candidate: {0}" -f $candidateRoot)
    Write-Host ("Backup: {0}" -f $backupRoot)
    Write-Host ''

    foreach ($rel in $runtimeFiles) {
        $src = Join-Path $candidateRoot ($rel -replace '/', '\')
        $dst = Join-Path $productionRoot ($rel -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $report.apply.filesApplied += $rel
    }
    $mutated = $true

    foreach ($rel in $runtimeFiles) {
        $dst = Join-Path $productionRoot ($rel -replace '/', '\')
        & $node --check $dst *> $null
        if ($LASTEXITCODE -ne 0) { throw "Node syntax preflight failed after apply: $rel" }
        if ((Get-FileSha256 -Path $dst) -ne $candidateHashes[$rel]) { throw "Applied file hash mismatch: $rel" }
    }
    $report.apply.syntaxPreflightPassed = $true

    $dependencyProbe = "process.chdir(" + (ConvertTo-Json $productionCore -Compress) + "); require('node-fetch'); require('ws'); require('./src/services/wechat-runtime-code-provider'); require('./src/services/wechat-recovery-manager'); require('./src/services/wechat-gateway-profile');"
    & $node -e $dependencyProbe *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency/module preflight failed after apply.' }
    $report.apply.dependencyPreflightPassed = $true

    if ((Get-FileSha256 -Path $accountsPath) -ne $accountsHashBefore) { throw 'Production accounts.json changed before service restart.' }

    $newExtra = @($oldEnvironmentExtra | Where-Object {
        $_ -notlike 'FARM_WECHAT_CODE_PROVIDER_URL=*' -and $_ -notlike 'FARM_WECHAT_CODE_PROVIDER_TOKEN=*'
    })
    $newExtra += "FARM_WECHAT_CODE_PROVIDER_URL=$machineUrl"
    $newExtra += "FARM_WECHAT_CODE_PROVIDER_TOKEN=$machineToken"
    Set-NssmEnvironmentExtra -RegistryKey $service.RegistryKey -Values ([string[]]$newExtra)

    $verifyProps = Get-ItemProperty -Path $service.RegistryKey -ErrorAction Stop
    $verifyExtra = @($verifyProps.AppEnvironmentExtra | ForEach-Object { [string]$_ })
    $hasUrl = @($verifyExtra | Where-Object { $_ -like 'FARM_WECHAT_CODE_PROVIDER_URL=*' }).Count -eq 1
    $hasToken = @($verifyExtra | Where-Object { $_ -like 'FARM_WECHAT_CODE_PROVIDER_TOKEN=*' }).Count -eq 1
    if (-not $hasUrl -or -not $hasToken) { throw 'NSSM Provider environment injection verification failed.' }
    $report.provider.nssmEnvInjected = $true

    Write-Host 'Applied 5 audited runtime files.' -ForegroundColor Green
    Write-Host 'Syntax/dependency preflight: PASS' -ForegroundColor Green
    Write-Host 'NSSM Provider env injection: PASS (values hidden)' -ForegroundColor Green
    Write-Host 'Restarting FAR2Farm once for deployment activation...' -ForegroundColor Yellow

    $restartAttempted = $true
    $report.apply.serviceRestartAttempted = $true
    Restart-Service -Name $ServiceName -Force -ErrorAction Stop
    $running = Wait-ServiceRunning -Name $ServiceName -OldPid $service.ProcessId -TimeoutSec 50
    if (-not $running -or [string]$running.State -ne 'Running' -or [int]$running.ProcessId -le 0) {
        throw 'FAR2Farm did not return to Running after deployment restart.'
    }
    $newPid = [int]$running.ProcessId
    Start-Sleep -Seconds 12
    $stable = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop
    if ([string]$stable.State -ne 'Running' -or [int]$stable.ProcessId -ne $newPid) {
        throw 'FAR2Farm did not remain stable after restart.'
    }
    $report.production.servicePidAfter = $newPid
    $report.apply.serviceRunningStable = $true

    $accountsHashAfter = Get-FileSha256 -Path $accountsPath
    $report.production.accountsSha256After = $accountsHashAfter
    $report.production.accountsUnchanged = ($accountsHashAfter -eq $accountsHashBefore)
    if (-not $report.production.accountsUnchanged) { throw 'Production accounts.json changed during controlled apply.' }

    foreach ($rel in $runtimeFiles) {
        $dst = Join-Path $productionRoot ($rel -replace '/', '\')
        if ((Get-FileSha256 -Path $dst) -ne $candidateHashes[$rel]) { throw "Production file drifted after restart: $rel" }
    }

    $agentAfter = Test-AgentHealth -Url $machineUrl -Token $machineToken
    $report.provider.residentReadyAfter = $agentAfter.Available
    if (-not $agentAfter.Available -or $agentAfter.AppId -ne $expectedAppId) { throw "Resident Agent became unavailable after FAR2Farm restart: $($agentAfter.Reason)" }

    $report.gatePassed = $true
    Write-Report -Report $report -Path $reportPath

    Write-Host ''
    Write-Host 'P8 controlled production apply completed.' -ForegroundColor Green
    Write-Host ("FAR2Farm PID: {0} -> {1}" -f $service.ProcessId, $newPid)
    Write-Host 'Production accounts.json unchanged: True'
    Write-Host 'Resident Agent still ready: True'
    Write-Host 'Five audited runtime files active: True'
    Write-Host 'NSSM Provider env active for restarted service: True'
    Write-Host 'Controlled apply gate passed: True'
    Write-Host ''
    Write-Host 'Report path:'
    Write-Host $reportPath
    Write-Host ''
    Write-Host 'Do not stop the Resident Agent. Do not add a WeChat account manually yet; the next gate will do that in a controlled way.' -ForegroundColor Yellow
    exit 0
}
catch {
    $failure = if ($_.Exception -and $_.Exception.Message) { [string]$_.Exception.Message } else { [string]$_ }
    $report.rollback.reason = $failure
    Write-Host ''
    Write-Host ("Controlled apply failed: {0}" -f $failure) -ForegroundColor Red

    if ($mutated) {
        $report.rollback.attempted = $true
        $rollbackOk = $true
        try {
            Copy-Item -LiteralPath $backupClient -Destination $productionClient -Force
            foreach ($rel in $runtimeFiles | Where-Object { $_ -ne 'core/client.js' }) {
                $dst = Join-Path $productionRoot ($rel -replace '/', '\')
                Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
            }
            if ($oldHadEnvironmentExtra) {
                Set-NssmEnvironmentExtra -RegistryKey $service.RegistryKey -Values $oldEnvironmentExtra
            }
            else {
                Remove-ItemProperty -Path $service.RegistryKey -Name 'AppEnvironmentExtra' -ErrorAction SilentlyContinue
            }
            if ((Get-FileSha256 -Path $productionClient) -ne $prodClientHash) { throw 'client.js rollback hash mismatch' }
            if ((Get-FileSha256 -Path $accountsPath) -ne $accountsHashBefore) { throw 'accounts.json changed; automatic rollback refuses to overwrite data' }

            if ($restartAttempted) {
                $svcNow = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
                if ($svcNow -and [string]$svcNow.State -eq 'Running') {
                    Restart-Service -Name $ServiceName -Force -ErrorAction Stop
                }
                else {
                    Start-Service -Name $ServiceName -ErrorAction Stop
                }
                $rollbackRunning = Wait-ServiceRunning -Name $ServiceName -OldPid 0 -TimeoutSec 50
                if (-not $rollbackRunning -or [string]$rollbackRunning.State -ne 'Running') { throw 'service did not recover after rollback' }
            }
        }
        catch {
            $rollbackOk = $false
            $report.rollback.reason = $failure + '; rollback_error=' + [string]$_.Exception.Message
        }
        $report.rollback.succeeded = $rollbackOk
    }

    try {
        $report.production.accountsSha256After = Get-FileSha256 -Path $accountsPath
        $report.production.accountsUnchanged = ($report.production.accountsSha256After -eq $accountsHashBefore)
    } catch {}
    $report.gatePassed = $false
    try { Write-Report -Report $report -Path $reportPath } catch {}

    Write-Host ("Automatic rollback attempted: {0}" -f $report.rollback.attempted)
    Write-Host ("Automatic rollback succeeded: {0}" -f $report.rollback.succeeded)
    Write-Host ("Production accounts.json unchanged: {0}" -f $report.production.accountsUnchanged)
    Write-Host ''
    Write-Host 'Report path:'
    Write-Host $reportPath
    Write-Host ''
    Write-Host 'Do not perform manual reset/checkout/clean. Send this output/report for targeted recovery.' -ForegroundColor Yellow
    exit 2
}