param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stageBase = Join-Path $env:LOCALAPPDATA 'FAR2\p8-stage'
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$gateScript = Join-Path $projectRoot 'core\scripts\wechat-p8-stage-recovery-gate.js'
$workerScript = Join-Path $projectRoot 'core\scripts\wechat-p8-login-only-worker.js'

function Get-LatestStage {
    if (-not (Test-Path -LiteralPath $stageBase)) { throw "P8 stage base not found: $stageBase" }
    $dirs = @(Get-ChildItem -LiteralPath $stageBase -Directory -ErrorAction Stop | Sort-Object Name -Descending)
    foreach ($dir in $dirs) {
        $manifest = Join-Path $dir.FullName 'P8-STAGE.json'
        if (Test-Path -LiteralPath $manifest) {
            try {
                $data = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($data.stage.syntaxPreflight -eq $true -and (Test-Path -LiteralPath ([string]$data.stage.core))) {
                    return [pscustomobject]@{ Root=$dir.FullName; ManifestPath=$manifest; Manifest=$data }
                }
            } catch {}
        }
    }
    throw 'No valid P8 isolated stage was found. Run prepare-wechat-p8-stage.cmd first.'
}

function Get-NodePath {
    param($Manifest)
    $candidate = [string]$Manifest.production.application
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) { return [string]$node.Source }
    throw 'Node.js was not found.'
}

function Add-NodePath {
    param([string]$Candidate)
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate)) { return }
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($env:NODE_PATH)) {
        $parts = @($env:NODE_PATH -split [regex]::Escape([string][IO.Path]::PathSeparator))
    }
    if ($parts -notcontains $Candidate) {
        if ([string]::IsNullOrWhiteSpace($env:NODE_PATH)) { $env:NODE_PATH = $Candidate }
        else { $env:NODE_PATH = $Candidate + [IO.Path]::PathSeparator + $env:NODE_PATH }
    }
}

function Get-ServiceSnapshot {
    param([string]$Name)
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
    return [pscustomobject]@{
        State = [string]$svc.State
        ProcessId = [int]$svc.ProcessId
    }
}

function Get-TrackedStatusText {
    param([string]$Root)
    if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return '' }
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { return '' }
    try {
        return (@(& $git.Source -C $Root status --porcelain --untracked-files=no 2>$null) -join "`n")
    } catch { return '' }
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 Isolated Stage Real Recovery Gate' -ForegroundColor Cyan
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host 'Production FAR2Farm/QQ workers stay running and are not controlled by this gate.' -ForegroundColor DarkGray
Write-Host 'The validation account exists only inside the copied stage and is removed afterward.' -ForegroundColor DarkGray
Write-Host 'The login-only worker uses the staged FAR2 gateway/network stack and starts no farm automation.' -ForegroundColor DarkGray
Write-Host 'Raw wx.login Code remains transient in memory/IPC only and is never printed or written to accounts.json/report.' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path -LiteralPath $gateScript)) { throw "Gate script not found: $gateScript" }
if (-not (Test-Path -LiteralPath $workerScript)) { throw "Login-only worker script not found: $workerScript" }

$stage = Get-LatestStage
$manifest = $stage.Manifest
$stageCore = [string]$manifest.stage.core
$prodAppDirectory = [string]$manifest.production.appDirectory
$prodAccountsFile = Join-Path $prodAppDirectory 'data\accounts.json'
$prodRoot = Split-Path -Parent $prodAppDirectory
if (-not (Test-Path -LiteralPath $prodAccountsFile)) { throw "Production accounts.json not found: $prodAccountsFile" }

$beforeService = Get-ServiceSnapshot -Name $ServiceName
if ($beforeService.State -ne 'Running') { throw "Production service $ServiceName is not Running." }
$beforeAccountsHash = (Get-FileHash -LiteralPath $prodAccountsFile -Algorithm SHA256).Hash
$beforeTracked = Get-TrackedStatusText -Root $prodRoot

$providerUrl = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', 'Machine')
$providerToken = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
if ([string]::IsNullOrWhiteSpace($providerUrl)) { $providerUrl = 'http://127.0.0.1:43201/' }
if ($providerToken.Length -lt 24) { throw 'Machine WeChat Provider token is missing. Keep the resident-agent setup from the previous step.' }

$node = Get-NodePath -Manifest $manifest
$oldNodePath = $env:NODE_PATH
$oldProviderUrl = $env:FARM_WECHAT_CODE_PROVIDER_URL
$oldProviderToken = $env:FARM_WECHAT_CODE_PROVIDER_TOKEN
$oldStageCore = $env:FAR2_P8_STAGE_CORE
$oldReportPath = $env:FAR2_P8_GATE_REPORT_PATH
$oldAutoRefresh = $env:FARM_WECHAT_CODE_AUTO_REFRESH

try {
    Add-NodePath -Candidate (Join-Path $prodAppDirectory 'node_modules')
    Add-NodePath -Candidate (Join-Path $env:LOCALAPPDATA 'FAR2\wechat-agent\node-deps\node_modules')
    Add-NodePath -Candidate (Join-Path $projectRoot 'core\node_modules')

    $env:FARM_WECHAT_CODE_PROVIDER_URL = $providerUrl
    $env:FARM_WECHAT_CODE_PROVIDER_TOKEN = $providerToken
    $env:FARM_WECHAT_CODE_AUTO_REFRESH = '1'
    $env:FAR2_P8_STAGE_CORE = $stageCore

    New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $reportPath = Join-Path $reportRoot ("wechat-p8-stage-recovery-{0}.json" -f $stamp)
    $env:FAR2_P8_GATE_REPORT_PATH = $reportPath

    & $node --check $gateScript *> $null
    if ($LASTEXITCODE -ne 0) { throw 'P8 stage gate JavaScript syntax check failed.' }
    & $node --check $workerScript *> $null
    if ($LASTEXITCODE -ne 0) { throw 'P8 login-only worker JavaScript syntax check failed.' }

    Write-Host ("Stage: {0}" -f $stage.Root)
    Write-Host ("Stage source HEAD: {0}" -f [string]$manifest.source.head)
    Write-Host ("Production service before gate: {0} / PID {1}" -f $beforeService.State, $beforeService.ProcessId)
    Write-Host 'Resident Provider token: configured (value hidden)'
    Write-Host ''

    Push-Location -LiteralPath (Join-Path $projectRoot 'core')
    try {
        & $node $gateScript
        $nodeExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $reportPath)) {
        throw "P8 Node gate did not produce a report (exit=$nodeExit)."
    }

    $afterService = Get-ServiceSnapshot -Name $ServiceName
    $afterAccountsHash = (Get-FileHash -LiteralPath $prodAccountsFile -Algorithm SHA256).Hash
    $afterTracked = Get-TrackedStatusText -Root $prodRoot
    $productionSafe = (
        $beforeService.State -eq 'Running' -and
        $afterService.State -eq 'Running' -and
        $beforeService.ProcessId -gt 0 -and
        $afterService.ProcessId -eq $beforeService.ProcessId -and
        $afterAccountsHash -eq $beforeAccountsHash -and
        $afterTracked -ceq $beforeTracked
    )

    $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $report | Add-Member -NotePropertyName productionSafety -NotePropertyValue ([pscustomobject]@{
        serviceName = $ServiceName
        serviceStayedRunning = ($beforeService.State -eq 'Running' -and $afterService.State -eq 'Running')
        servicePidUnchanged = ($afterService.ProcessId -eq $beforeService.ProcessId)
        productionAccountsHashUnchanged = ($afterAccountsHash -eq $beforeAccountsHash)
        productionTrackedStatusUnchanged = ($afterTracked -ceq $beforeTracked)
        qqProductionUntouched = $productionSafe
    }) -Force
    $report.gatePassed = ($report.gatePassed -eq $true -and $productionSafe)
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8

    Write-Host ''
    Write-Host ("Production service stayed running: {0}" -f $report.productionSafety.serviceStayedRunning)
    Write-Host ("Production service PID unchanged: {0}" -f $report.productionSafety.servicePidUnchanged)
    Write-Host ("Production accounts.json unchanged: {0}" -f $report.productionSafety.productionAccountsHashUnchanged)
    Write-Host ("Production tracked state unchanged: {0}" -f $report.productionSafety.productionTrackedStatusUnchanged)
    Write-Host ("QQ production untouched: {0}" -f $report.productionSafety.qqProductionUntouched)
    Write-Host ("P8 isolated recovery gate passed: {0}" -f $report.gatePassed)
    Write-Host ''
    Write-Host 'Report path:'
    Write-Host $reportPath

    if ($nodeExit -ne 0 -or $report.gatePassed -ne $true) {
        Write-Host ''
        Write-Host 'P8 isolated recovery gate FAILED. Do not restart FAR2Farm.' -ForegroundColor Yellow
        exit 2
    }

    Write-Host ''
    Write-Host 'P8 isolated recovery gate PASSED. Production FAR2Farm was not restarted.' -ForegroundColor Green
    exit 0
}
finally {
    $env:NODE_PATH = $oldNodePath
    $env:FARM_WECHAT_CODE_PROVIDER_URL = $oldProviderUrl
    $env:FARM_WECHAT_CODE_PROVIDER_TOKEN = $oldProviderToken
    $env:FAR2_P8_STAGE_CORE = $oldStageCore
    $env:FAR2_P8_GATE_REPORT_PATH = $oldReportPath
    $env:FARM_WECHAT_CODE_AUTO_REFRESH = $oldAutoRefresh
}
