param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$auditBase = Join-Path $env:LOCALAPPDATA 'FAR2\p8-production-client-resolution'
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
    return [pscustomobject]@{
        State = [string]$svc.State
        ProcessId = [int]$svc.ProcessId
        AppDirectory = [System.IO.Path]::GetFullPath($appDirectory)
    }
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OnlyIndex {
    param([string]$Text, [string]$Needle, [string]$Label)
    $first = $Text.IndexOf($Needle, [StringComparison]::Ordinal)
    if ($first -lt 0) { throw "Required anchor missing: $Label" }
    $second = $Text.IndexOf($Needle, $first + $Needle.Length, [StringComparison]::Ordinal)
    if ($second -ge 0) { throw "Required anchor is not unique: $Label" }
    return $first
}

function Extract-Between {
    param(
        [string]$Text,
        [string]$StartNeedle,
        [string]$EndNeedle,
        [string]$Label
    )
    $start = Get-OnlyIndex -Text $Text -Needle $StartNeedle -Label "$Label start"
    $end = $Text.IndexOf($EndNeedle, $start + $StartNeedle.Length, [StringComparison]::Ordinal)
    if ($end -lt 0) { throw "Required extraction end missing: $Label" }
    return $Text.Substring($start, $end - $start)
}

function Insert-BeforeUnique {
    param(
        [string]$Text,
        [string]$Anchor,
        [string]$Chunk,
        [string]$AlreadyMarker,
        [string]$Label
    )
    if (-not [string]::IsNullOrEmpty($AlreadyMarker) -and $Text.Contains($AlreadyMarker)) {
        return [pscustomobject]@{ Text=$Text; Changed=$false; Label=$Label }
    }
    $idx = Get-OnlyIndex -Text $Text -Needle $Anchor -Label $Label
    $next = $Text.Substring(0, $idx) + $Chunk + $Text.Substring($idx)
    return [pscustomobject]@{ Text=$next; Changed=$true; Label=$Label }
}

function Insert-AfterUnique {
    param(
        [string]$Text,
        [string]$Anchor,
        [string]$Chunk,
        [string]$AlreadyMarker,
        [string]$Label
    )
    if (-not [string]::IsNullOrEmpty($AlreadyMarker) -and $Text.Contains($AlreadyMarker)) {
        return [pscustomobject]@{ Text=$Text; Changed=$false; Label=$Label }
    }
    $idx = Get-OnlyIndex -Text $Text -Needle $Anchor -Label $Label
    $pos = $idx + $Anchor.Length
    $next = $Text.Substring(0, $pos) + $Chunk + $Text.Substring($pos)
    return [pscustomobject]@{ Text=$next; Changed=$true; Label=$Label }
}

function Find-NodeExe {
    $serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
    if (Test-Path -LiteralPath $serviceKey) {
        $props = Get-ItemProperty -Path $serviceKey -ErrorAction SilentlyContinue
        if ($props -and $props.PSObject.Properties.Name -contains 'Application') {
            $candidate = [string]$props.Application
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
        }
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($node) { return [string]$node.Source }
    $fallback = 'D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw 'Node executable was not found.'
}

Write-Host ''
Write-Host 'FAR2 WeChat P8 client.js Conflict Resolution Audit' -ForegroundColor Cyan
Write-Host '===================================================' -ForegroundColor Cyan
Write-Host 'READ ONLY: production FAR2Farm/worktree/data are not modified or restarted.' -ForegroundColor DarkGray
Write-Host 'The current production client.js is authoritative; P8 WeChat blocks are inserted only into an audit candidate.' -ForegroundColor DarkGray
Write-Host ''

$git = Get-GitExe
$service = Get-ServiceConfig -Name $ServiceName
if ($service.State -ne 'Running') { throw "Production service $ServiceName is not Running." }
$productionRoot = Split-Path -Parent $service.AppDirectory
$productionClient = Join-Path $productionRoot 'core\client.js'
$sourceClient = Join-Path $projectRoot 'core\client.js'
if (-not (Test-Path -LiteralPath $productionClient -PathType Leaf)) { throw "Production client.js missing: $productionClient" }
if (-not (Test-Path -LiteralPath $sourceClient -PathType Leaf)) { throw "P8 source client.js missing: $sourceClient" }

$productionHeadOutput = @(& $git -C $productionRoot rev-parse HEAD 2>$null)
$productionHead = if ($productionHeadOutput.Count -gt 0) { ([string]$productionHeadOutput[0]).Trim() } else { '' }
if (-not $productionHead) { throw 'Unable to read production HEAD.' }
$sourceHeadOutput = @(& $git -C $projectRoot rev-parse HEAD 2>$null)
$sourceHead = if ($sourceHeadOutput.Count -gt 0) { ([string]$sourceHeadOutput[0]).Trim() } else { '' }
if (-not $sourceHead) { throw 'Unable to read P8 source HEAD.' }

$productionPathStatus = @(& $git -C $productionRoot status --porcelain --untracked-files=no -- core/client.js 2>$null)
if ($productionPathStatus.Count -gt 0) {
    throw 'Production core/client.js became dirty after the migration audit. Refusing to synthesize a candidate from a moving target.'
}

$prodHashBefore = Get-FileSha256 -Path $productionClient
$sourceHash = Get-FileSha256 -Path $sourceClient
$prodText = Get-Content -LiteralPath $productionClient -Raw -Encoding UTF8
$sourceText = Get-Content -LiteralPath $sourceClient -Raw -Encoding UTF8

# Extract the exact P8 blocks from the current source instead of maintaining a second handwritten copy.
$bridgeChunk = Extract-Between -Text $sourceText `
    -StartNeedle 'function installWechatRecoveryDataProviderBridge(runtimeEngine, wechatRecoveryManager, wechatCodeProvider) {' `
    -EndNeedle '// 打包后 worker 由当前可执行文件以 --worker 模式启动' `
    -Label 'WeChat data-provider bridge'

$providerChunk = Extract-Between -Text $sourceText `
    -StartNeedle '    let wechatCodeProvider = null;' `
    -EndNeedle '    const runtimeEngine = createRuntimeEngine({' `
    -Label 'WeChat provider initialization'

$recoveryChunk = Extract-Between -Text $sourceText `
    -StartNeedle '    // WeChat recovery is intentionally separate from the mature QQ exact-UIN' `
    -EndNeedle '    // Unattended production default: start every saved account when FAR2 starts.' `
    -Label 'WeChat recovery wiring'

$candidate = $prodText
$steps = @()

$r = Insert-BeforeUnique -Text $candidate `
    -Anchor "const process = require('node:process');" `
    -Chunk "const path = require('node:path');`n" `
    -AlreadyMarker "const path = require('node:path');" `
    -Label 'node:path import'
$candidate = $r.Text; $steps += $r

$importAnchor = "const { createIsolatedRuntimeCodeProviderFromEnv } = require('./src/services/isolated-runtime-code-provider');"
$wechatImports = "`nconst { createWechatRuntimeCodeProviderFromEnv } = require('./src/services/wechat-runtime-code-provider');`nconst { createWechatRecoveryManager } = require('./src/services/wechat-recovery-manager');"
$r = Insert-AfterUnique -Text $candidate -Anchor $importAnchor -Chunk $wechatImports -AlreadyMarker "createWechatRuntimeCodeProviderFromEnv" -Label 'WeChat service imports'
$candidate = $r.Text; $steps += $r

$r = Insert-BeforeUnique -Text $candidate `
    -Anchor '// 打包后 worker 由当前可执行文件以 --worker 模式启动' `
    -Chunk $bridgeChunk `
    -AlreadyMarker 'function installWechatRecoveryDataProviderBridge(' `
    -Label 'WeChat data-provider bridge'
$candidate = $r.Text; $steps += $r

$workerAnchor = "if (isWorkerProcess) {"
$workerChunk = "`n    // Fork/pkg worker 也必须在 worker.js 导入 network.js 之前安装微信网关 profile。`n    require('./src/services/wechat-gateway-profile');"
$r = Insert-AfterUnique -Text $candidate -Anchor $workerAnchor -Chunk $workerChunk -AlreadyMarker "require('./src/services/wechat-gateway-profile');" -Label 'worker gateway profile bootstrap'
$candidate = $r.Text; $steps += $r

$r = Insert-BeforeUnique -Text $candidate `
    -Anchor '    const runtimeEngine = createRuntimeEngine({' `
    -Chunk $providerChunk `
    -AlreadyMarker '    let wechatCodeProvider = null;' `
    -Label 'WeChat Provider initialization'
$candidate = $r.Text; $steps += $r

$r = Insert-AfterUnique -Text $candidate `
    -Anchor '        mainEntryPath: __filename,' `
    -Chunk "`n        workerScriptPath: path.join(__dirname, 'src/core/worker-bootstrap.js')," `
    -AlreadyMarker "workerScriptPath: path.join(__dirname, 'src/core/worker-bootstrap.js')" `
    -Label 'worker bootstrap path'
$candidate = $r.Text; $steps += $r

$r = Insert-BeforeUnique -Text $candidate `
    -Anchor '    // Unattended production default: start every saved account when FAR2 starts.' `
    -Chunk $recoveryChunk `
    -AlreadyMarker '        const wechatRecoveryManager = createWechatRecoveryManager({' `
    -Label 'WeChat recovery wiring'
$candidate = $r.Text; $steps += $r

$requiredMarkers = @(
    "const path = require('node:path');",
    'createWechatRuntimeCodeProviderFromEnv',
    'createWechatRecoveryManager',
    'function installWechatRecoveryDataProviderBridge(',
    "require('./src/services/wechat-gateway-profile');",
    "workerScriptPath: path.join(__dirname, 'src/core/worker-bootstrap.js')",
    'wechatRecoveryManager.start();',
    'installWechatRecoveryDataProviderBridge(runtimeEngine, wechatRecoveryManager, wechatCodeProvider);'
)
$missingMarkers = @($requiredMarkers | Where-Object { -not $candidate.Contains($_) })
if ($missingMarkers.Count -gt 0) {
    throw ('Candidate is missing required P8 markers: ' + ($missingMarkers -join ', '))
}

if ($candidate.Contains('<<<<<<<') -or $candidate.Contains('=======') -or $candidate.Contains('>>>>>>>')) {
    throw 'Candidate contains merge conflict markers.'
}

New-Item -ItemType Directory -Force -Path $candidateRoot | Out-Null
$candidateClient = Join-Path $candidateRoot 'core\client.js'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $candidateClient) | Out-Null
[IO.File]::WriteAllText($candidateClient, $candidate, [Text.UTF8Encoding]::new($false))

foreach ($rel in $runtimeFiles | Where-Object { $_ -ne 'core/client.js' }) {
    $src = Join-Path $projectRoot ($rel -replace '/', '\')
    $dst = Join-Path $candidateRoot ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "P8 runtime file missing: $rel" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
}

$node = Find-NodeExe
$syntaxResults = @()
foreach ($rel in $runtimeFiles) {
    $candidatePath = Join-Path $candidateRoot ($rel -replace '/', '\')
    & $node --check $candidatePath *> $null
    $ok = ($LASTEXITCODE -eq 0)
    $syntaxResults += [pscustomobject]@{ path=$rel; ok=$ok }
    if (-not $ok) { throw "Node syntax preflight failed: $rel" }
}

$prodHashAfter = Get-FileSha256 -Path $productionClient
$productionUnchanged = ($prodHashBefore -eq $prodHashAfter)
if (-not $productionUnchanged) {
    throw 'Production client.js changed during the read-only audit. Refusing to continue.'
}

$candidateHash = Get-FileSha256 -Path $candidateClient
$changedSteps = @($steps | Where-Object { $_.Changed }).Count
$report = [ordered]@{
    version = 1
    phase = 'wechat-p8-production-client-semantic-resolution-audit'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{
        worktree = $projectRoot
        head = $sourceHead
        clientSha256 = $sourceHash
    }
    production = [ordered]@{
        serviceName = $ServiceName
        serviceState = $service.State
        servicePid = $service.ProcessId
        worktree = $productionRoot
        head = $productionHead
        clientPathStatus = ($productionPathStatus -join "`n")
        clientSha256Before = $prodHashBefore
        clientSha256After = $prodHashAfter
        clientUnchanged = $productionUnchanged
    }
    candidate = [ordered]@{
        root = $candidateRoot
        clientSha256 = $candidateHash
        semanticInsertionsApplied = $changedSteps
        conflictMarkersAbsent = $true
        requiredP8MarkersPresent = ($missingMarkers.Count -eq 0)
        syntaxPreflightPassed = (@($syntaxResults | Where-Object { -not $_.ok }).Count -eq 0)
    }
    steps = @($steps | ForEach-Object { [ordered]@{ label=$_.Label; changed=$_.Changed } })
    syntax = $syntaxResults
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
    readyForControlledApply = ($productionUnchanged -and $missingMarkers.Count -eq 0 -and @($syntaxResults | Where-Object { -not $_.ok }).Count -eq 0)
}

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
New-Item -ItemType Directory -Force -Path $auditRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-p8-client-resolution-audit-{0}.json" -f $stamp)
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $auditRoot 'AUDIT.json') -Encoding UTF8

Write-Host ("Source P8 HEAD: {0}" -f $sourceHead)
Write-Host ("Production HEAD: {0}" -f $productionHead)
Write-Host ("Production client.js clean at HEAD: {0}" -f ($productionPathStatus.Count -eq 0))
Write-Host ("Semantic P8 insertions applied: {0}" -f $changedSteps)
Write-Host ("Required P8 markers present: {0}" -f ($missingMarkers.Count -eq 0))
Write-Host ("Conflict markers absent: True")
Write-Host ("Syntax preflight passed: {0}" -f $report.candidate.syntaxPreflightPassed)
Write-Host ("Production client.js unchanged: {0}" -f $productionUnchanged)
Write-Host ("Ready for controlled apply: {0}" -f $report.readyForControlledApply)
Write-Host ''
Write-Host 'Resolved candidate workspace:'
Write-Host $auditRoot
Write-Host ''
Write-Host 'Report path:'
Write-Host $reportPath
Write-Host ''
Write-Host 'No production files or services were modified.' -ForegroundColor Green

if (-not $report.readyForControlledApply) {
    Write-Host 'P8 client conflict resolution audit FAILED. Do not apply/restart.' -ForegroundColor Yellow
    exit 2
}

Write-Host 'P8 client conflict resolution audit PASSED. Do not restart FAR2Farm yet.' -ForegroundColor Green
exit 0
