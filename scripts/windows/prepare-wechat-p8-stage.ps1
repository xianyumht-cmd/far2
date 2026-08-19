param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$stageBase = Join-Path $env:LOCALAPPDATA 'FAR2\p8-stage'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$stageRoot = Join-Path $stageBase $stamp
$archivePath = Join-Path $env:TEMP ("FAR2-p8-stage-{0}.zip" -f $stamp)

function Get-GitExe {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { throw 'git was not found.' }
    return [string]$git.Source
}

function Read-ServiceSnapshot {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { throw "Windows service not found: $Name" }
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    if (-not (Test-Path -LiteralPath $key)) { throw "NSSM service parameters key not found: $key" }
    $props = Get-ItemProperty -Path $key -ErrorAction Stop
    $appDirectory = [string]$props.AppDirectory
    $application = [string]$props.Application
    if ([string]::IsNullOrWhiteSpace($appDirectory)) { throw 'FAR2Farm AppDirectory is empty.' }
    return [pscustomobject]@{
        status = [string]$svc.Status
        appDirectory = $appDirectory
        application = $application
        appParameters = [string]$props.AppParameters
        dataDir = Join-Path $appDirectory 'data'
        accountsFile = Join-Path $appDirectory 'data\accounts.json'
    }
}

function Get-GitSnapshot {
    param([string]$Root, [string]$Git)
    $result = [ordered]@{ available=$false; root=''; head=''; branch=''; trackedDirty=$null }
    if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return [pscustomobject]$result }
    try {
        $top = (& $Git -C $Root rev-parse --show-toplevel 2>$null).Trim()
        if (-not $top) { return [pscustomobject]$result }
        $result.available = $true
        $result.root = [System.IO.Path]::GetFullPath($top)
        $result.head = (& $Git -C $Root rev-parse HEAD 2>$null).Trim()
        $result.branch = (& $Git -C $Root branch --show-current 2>$null).Trim()
        $dirty = @(& $Git -C $Root status --porcelain --untracked-files=no 2>$null)
        $result.trackedDirty = ($dirty.Count -gt 0)
    } catch {}
    return [pscustomobject]$result
}

function Read-AccountSummary {
    param([string]$File)
    $result = [ordered]@{ readable=$false; total=0; qq=0; wx=0; configuredWx=0 }
    if (-not (Test-Path -LiteralPath $File)) { return [pscustomobject]$result }
    try {
        $raw = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
        $accounts = if ($raw.accounts) { @($raw.accounts) } elseif ($raw -is [System.Array]) { @($raw) } else { @() }
        $result.readable = $true
        $result.total = $accounts.Count
        foreach ($account in $accounts) {
            $platform = if ($account.platform) { ([string]$account.platform).ToLowerInvariant() } else { 'qq' }
            if ($platform -eq 'wx') {
                $result.wx++
                $mode = if ($account.codeRefreshMode) { ([string]$account.codeRefreshMode).ToLowerInvariant() } else { '' }
                if ($account.codeRefreshEnabled -eq $true -and $mode -in @('windows_wechat','windows_session')) { $result.configuredWx++ }
            } else {
                $result.qq++
            }
        }
    } catch {}
    return [pscustomobject]$result
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 Isolated Stage Preparation' -ForegroundColor Cyan
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host 'Production FAR2Farm is NOT restarted and its worktree/data are NOT modified.' -ForegroundColor DarkGray
Write-Host 'A new local stage is created from the current probe HEAD, then production data is copied into the stage.' -ForegroundColor DarkGray
Write-Host ''

$git = Get-GitExe
$current = Get-GitSnapshot -Root $projectRoot -Git $git
if (-not $current.available -or -not $current.head) { throw 'Current probe worktree is not a readable git checkout.' }
if ($current.trackedDirty -eq $true) { throw 'Current probe worktree has tracked changes; commit them before staging.' }

$service = Read-ServiceSnapshot -Name $ServiceName
if (-not (Test-Path -LiteralPath $service.dataDir)) { throw "Production data directory not found: $($service.dataDir)" }
if (-not (Test-Path -LiteralPath $service.accountsFile)) { throw "Production accounts.json not found: $($service.accountsFile)" }
$prodRoot = Split-Path -Parent $service.appDirectory
$prodGit = Get-GitSnapshot -Root $prodRoot -Git $git
$prodAccounts = Read-AccountSummary -File $service.accountsFile

New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
try {
    & $git -C $projectRoot archive --format=zip --output=$archivePath HEAD
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archivePath)) { throw 'git archive failed.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stageRoot -Force
} finally {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
}

$stageCore = Join-Path $stageRoot 'core'
$stageData = Join-Path $stageCore 'data'
if (-not (Test-Path -LiteralPath $stageCore)) { throw 'Staged core directory is missing after archive extraction.' }
if (Test-Path -LiteralPath $stageData) { Remove-Item -LiteralPath $stageData -Recurse -Force }
Copy-Item -LiteralPath $service.dataDir -Destination $stageData -Recurse -Force

$required = @(
    (Join-Path $stageCore 'client.js'),
    (Join-Path $stageCore 'src\services\wechat-runtime-code-provider.js'),
    (Join-Path $stageCore 'src\services\wechat-recovery-manager.js'),
    (Join-Path $stageCore 'src\services\wechat-gateway-profile.js'),
    (Join-Path $stageCore 'src\core\worker-bootstrap.js')
)
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Required P8 staged file is missing: $file" }
}

$node = ''
if ($service.application -and (Test-Path -LiteralPath $service.application)) { $node = $service.application }
if (-not $node) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $node = [string]$cmd.Source }
}
if (-not $node) { throw 'Node.js was not found for staged syntax preflight.' }
foreach ($file in $required) {
    & $node --check $file *> $null
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $file" }
}

$stageAccounts = Read-AccountSummary -File (Join-Path $stageData 'accounts.json')
$manifest = [ordered]@{
    version = 1
    phase = 'wechat-p8-isolated-stage'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{
        worktree = $projectRoot
        head = $current.head
        branch = $current.branch
    }
    production = [ordered]@{
        serviceName = $ServiceName
        serviceStatus = $service.status
        appDirectory = $service.appDirectory
        worktreeHead = $prodGit.head
        worktreeBranch = $prodGit.branch
        trackedDirty = $prodGit.trackedDirty
        dataSource = $service.dataDir
    }
    stage = [ordered]@{
        root = $stageRoot
        core = $stageCore
        data = $stageData
        syntaxPreflight = $true
    }
    accounts = [ordered]@{
        production = $prodAccounts
        stage = $stageAccounts
    }
    safety = [ordered]@{
        productionServiceRestarted = $false
        productionWorktreeModified = $false
        productionDataModified = $false
        wxLoginCalled = $false
        rawCodePrinted = $false
        providerTokenPrinted = $false
    }
}

$manifestPath = Join-Path $stageRoot 'P8-STAGE.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-p8-stage-{0}.json" -f $stamp)
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ("Probe source HEAD: {0}" -f $current.head)
Write-Host ("Production service: {0} / {1}" -f $ServiceName, $service.status)
Write-Host ("Production worktree dirty: {0}" -f $prodGit.trackedDirty)
Write-Host ("Production accounts: total={0} qq={1} wx={2}" -f $prodAccounts.total, $prodAccounts.qq, $prodAccounts.wx)
Write-Host ("Stage accounts copy: total={0} qq={1} wx={2}" -f $stageAccounts.total, $stageAccounts.qq, $stageAccounts.wx)
Write-Host 'P8 staged syntax preflight: PASS' -ForegroundColor Green
Write-Host ''
Write-Host 'Isolated stage:'
Write-Host $stageRoot
Write-Host ''
Write-Host 'Report path:'
Write-Host $reportPath
Write-Host ''
Write-Host 'Stage preparation completed. FAR2Farm was not restarted.' -ForegroundColor Green
Write-Host 'Do not point FAR2Farm at this stage manually yet.' -ForegroundColor Yellow
