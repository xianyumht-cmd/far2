param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$auditBase = Join-Path $env:LOCALAPPDATA 'FAR2\wechat-webui-closeout-audit'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$auditRoot = Join-Path $auditBase $stamp
$candidateRoot = Join-Path $auditRoot 'candidate'
$stageWeb = Join-Path $auditRoot 'web'
$expectedAppId = 'wx5306c5978fdb76e4'

function Get-Prop {
    param([object]$Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    return $prop.Value
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-GitExe {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { throw 'git was not found.' }
    return [string]$git.Source
}

function Get-NodeExe {
    param([object]$Service)
    $candidate = [string](Get-Prop $Service 'Application' '')
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($node) { return [string]$node.Source }
    $fallback = 'D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw 'Node executable was not found.'
}

function Get-ServiceConfig {
    param([string]$Name)
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    $props = Get-ItemProperty -Path $key -ErrorAction Stop
    $appDir = [string](Get-Prop $props 'AppDirectory' '')
    if (-not $appDir) { throw 'FAR2Farm AppDirectory is empty.' }
    return [pscustomobject]@{
        State = [string]$svc.State
        ProcessId = [int]$svc.ProcessId
        AppDirectory = [IO.Path]::GetFullPath($appDir)
        Application = [string](Get-Prop $props 'Application' '')
    }
}

function Test-AgentHealth {
    $token = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_TOKEN', 'Machine')
    $url = [string][Environment]::GetEnvironmentVariable('FARM_WECHAT_CODE_PROVIDER_URL', 'Machine')
    if ([string]::IsNullOrWhiteSpace($url)) { $url = 'http://127.0.0.1:43201/' }
    if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 24) {
        return [pscustomobject]@{ Available=$false; Reason='provider_token_missing'; AppId='' }
    }
    try {
        $endpoint = ([Uri]::new([Uri]$url, 'v1/health')).AbsoluteUri
        $headers = @{ Authorization = "Bearer $token"; Accept='application/json'; 'Cache-Control'='no-store' }
        $res = Invoke-RestMethod -Method Get -Uri $endpoint -Headers $headers -TimeoutSec 8
        return [pscustomobject]@{
            Available = ($res.ok -eq $true -and $res.available -eq $true)
            Reason = [string](Get-Prop $res 'reason' 'ok')
            AppId = [string](Get-Prop $res 'appId' '')
        }
    } catch {
        return [pscustomobject]@{ Available=$false; Reason='provider_health_failed'; AppId='' }
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $enc = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($Path, $Text, $enc)
}

function Get-GitText {
    param([string]$Git, [string]$Root, [string]$Spec)
    $lines = @(& $Git -C $Root show $Spec 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "git show failed: $Spec" }
    return ($lines -join "`n") + "`n"
}

function New-ThreeWayCandidate {
    param(
        [string]$Git,
        [string]$ProductionRoot,
        [string]$SourceRoot,
        [string]$MergeBase,
        [string]$RelativePath,
        [string]$OutputPath
    )
    $prodPath = Join-Path $ProductionRoot ($RelativePath -replace '/', '\')
    $srcPath = Join-Path $SourceRoot ($RelativePath -replace '/', '\')
    if (-not (Test-Path -LiteralPath $prodPath -PathType Leaf)) { throw "Production file missing: $RelativePath" }
    if (-not (Test-Path -LiteralPath $srcPath -PathType Leaf)) { throw "Source file missing: $RelativePath" }

    $tempDir = Join-Path $auditRoot ('merge-' + ([IO.Path]::GetFileNameWithoutExtension($RelativePath)))
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $basePath = Join-Path $tempDir 'base.txt'
    $prodCopy = Join-Path $tempDir 'prod.txt'
    $srcCopy = Join-Path $tempDir 'source.txt'
    Copy-Item -LiteralPath $prodPath -Destination $prodCopy -Force
    Copy-Item -LiteralPath $srcPath -Destination $srcCopy -Force
    Write-Utf8NoBom -Path $basePath -Text (Get-GitText -Git $Git -Root $SourceRoot -Spec "$MergeBase`:$RelativePath")

    $merged = @(& $Git merge-file -p $prodCopy $basePath $srcCopy 2>$null)
    $code = $LASTEXITCODE
    $text = ($merged -join "`n") + "`n"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    Write-Utf8NoBom -Path $OutputPath -Text $text
    return [pscustomobject]@{
        path = $RelativePath
        mergeExitCode = $code
        conflict = ($code -ne 0)
        candidateSha256 = Get-FileSha256 -Path $OutputPath
        productionSha256 = Get-FileSha256 -Path $prodPath
        sourceSha256 = Get-FileSha256 -Path $srcPath
    }
}

Write-Host ''
Write-Host 'FAR2 WeChat WebUI / Legacy Closeout Audit' -ForegroundColor Cyan
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host 'READ ONLY: production FAR2Farm/worktree/data/web dist are not modified or restarted.' -ForegroundColor DarkGray
Write-Host 'This audit builds an isolated WebUI candidate and a semantic production client.js candidate.' -ForegroundColor DarkGray
Write-Host ''

$git = Get-GitExe
$service = Get-ServiceConfig -Name $ServiceName
if ($service.State -ne 'Running' -or $service.ProcessId -le 0) { throw "$ServiceName is not Running." }
$productionCore = $service.AppDirectory
$productionRoot = Split-Path -Parent $productionCore
$node = Get-NodeExe -Service $service
$agent = Test-AgentHealth

$sourceHead = [string]((& $git -C $projectRoot rev-parse HEAD 2>$null) | Select-Object -First 1)
$productionHead = [string]((& $git -C $productionRoot rev-parse HEAD 2>$null) | Select-Object -First 1)
$mergeBase = [string]((& $git -C $projectRoot merge-base $sourceHead $productionHead 2>$null) | Select-Object -First 1)
if (-not $sourceHead -or -not $productionHead -or -not $mergeBase) { throw 'Unable to resolve source/production Git ancestry.' }

$accountsPath = Join-Path $productionCore 'data\accounts.json'
$accountsHashBefore = Get-FileSha256 -Path $accountsPath
$servicePidBefore = $service.ProcessId
$prodClient = Join-Path $productionCore 'client.js'
$prodClientHashBefore = Get-FileSha256 -Path $prodClient

New-Item -ItemType Directory -Force -Path $candidateRoot | Out-Null
$clientCandidate = Join-Path $candidateRoot 'core\client.js'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $clientCandidate) | Out-Null
$clientText = Get-Content -LiteralPath $prodClient -Raw -Encoding UTF8
$clientStatus = 'already_integrated'

if ($clientText -notmatch 'originalStartAccount' -or $clientText -notmatch "triggerRefresh\(id, 'web_enroll'\)") {
    $triggerPattern = "(?ms)(    const originalTriggerCodeRefresh = typeof dataProvider\.triggerCodeRefresh === 'function'\r?\n        \? dataProvider\.triggerCodeRefresh\.bind\(dataProvider\)\r?\n        : null;\r?\n)"
    $triggerMatches = [regex]::Matches($clientText, $triggerPattern)
    if ($triggerMatches.Count -ne 1) { throw "client.js semantic anchor mismatch: originalTriggerCodeRefresh count=$($triggerMatches.Count)" }
    $captureBlock = "    const originalStartAccount = typeof dataProvider.startAccount === 'function'`n        ? dataProvider.startAccount.bind(dataProvider)`n        : null;`n"
    $clientText = [regex]::Replace($clientText, $triggerPattern, ('$1' + $captureBlock), 1)

    $statusAnchor = "`n    dataProvider.getCodeManagerStatus = (accountRef = '') => {"
    $anchorCount = ([regex]::Matches($clientText, [regex]::Escape($statusAnchor))).Count
    if ($anchorCount -ne 1) { throw "client.js semantic anchor mismatch: getCodeManagerStatus count=$anchorCount" }
    $startBlock = @"

    dataProvider.startAccount = (accountRef) => {
        const account = getAccount(accountRef);
        if (account && String(account.platform || '').toLowerCase() === 'wx') {
            const id = String(account.id || '');
            const code = String(account.code || '').trim();
            const mode = String(account.codeRefreshMode || 'windows_wechat').toLowerCase();
            const residentConfigured = account.codeRefreshEnabled === true
                && (mode === 'windows_wechat' || mode === 'windows_session');
            if (residentConfigured && !code) {
                return wechatRecoveryManager.triggerRefresh(id, 'web_enroll');
            }
        }
        if (!originalStartAccount) return false;
        return originalStartAccount(accountRef);
    };
"@
    $clientText = $clientText.Replace($statusAnchor, ($startBlock + $statusAnchor))
    $clientStatus = 'semantic_insert_ready'
}
Write-Utf8NoBom -Path $clientCandidate -Text $clientText

& $node --check $clientCandidate *> $null
$clientSyntaxOk = ($LASTEXITCODE -eq 0)
$clientMarkersOk = $clientText.Contains('originalStartAccount') -and $clientText.Contains("triggerRefresh(id, 'web_enroll')")

$webFiles = @(
    'web/src/components/AccountModal.vue',
    'web/src/stores/wx-login.ts'
)
$mergeResults = @()
foreach ($rel in $webFiles) {
    $out = Join-Path $candidateRoot ($rel -replace '/', '\')
    $mergeResults += New-ThreeWayCandidate -Git $git -ProductionRoot $productionRoot -SourceRoot $projectRoot -MergeBase $mergeBase -RelativePath $rel -OutputPath $out
}
$webConflicts = @($mergeResults | Where-Object { $_.conflict }).Count

$prodWeb = Join-Path $productionRoot 'web'
if (-not (Test-Path -LiteralPath $prodWeb -PathType Container)) { throw "Production web directory missing: $prodWeb" }
New-Item -ItemType Directory -Force -Path $stageWeb | Out-Null
& robocopy $prodWeb $stageWeb /E /XD node_modules dist .git /NFL /NDL /NJH /NJS /NP *> $null
$roboCode = $LASTEXITCODE
if ($roboCode -gt 7) { throw "robocopy production web -> stage failed with code $roboCode" }
foreach ($rel in $webFiles) {
    $candidate = Join-Path $candidateRoot ($rel -replace '/', '\')
    $relativeInsideWeb = $rel.Substring(4) -replace '/', '\'
    $dest = Join-Path $stageWeb $relativeInsideWeb
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $candidate -Destination $dest -Force
}

$depsCandidates = @(
    (Join-Path $projectRoot 'web\node_modules'),
    (Join-Path $productionRoot 'web\node_modules')
)
$depsRoot = @($depsCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1)
$buildDepsAvailable = ($depsRoot.Count -eq 1)
$buildPassed = $false
$legacyPrimaryRetired = $false
if ($webConflicts -eq 0 -and $buildDepsAvailable) {
    $stageNodeModules = Join-Path $stageWeb 'node_modules'
    if (Test-Path -LiteralPath $stageNodeModules) { Remove-Item -LiteralPath $stageNodeModules -Force -Recurse }
    New-Item -ItemType Junction -Path $stageNodeModules -Target $depsRoot[0] | Out-Null
    $vueTsc = Join-Path $stageNodeModules 'vue-tsc\bin\vue-tsc.js'
    $vite = Join-Path $stageNodeModules 'vite\bin\vite.js'
    if ((Test-Path -LiteralPath $vueTsc -PathType Leaf) -and (Test-Path -LiteralPath $vite -PathType Leaf)) {
        Push-Location -LiteralPath $stageWeb
        try {
            & $node $vueTsc -b
            $typeCode = $LASTEXITCODE
            if ($typeCode -eq 0) {
                & $node $vite build
                $viteCode = $LASTEXITCODE
                $buildPassed = ($viteCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $stageWeb 'dist\index.html') -PathType Leaf))
            }
        } finally { Pop-Location }
    }
}

$accountModalCandidate = Get-Content -LiteralPath (Join-Path $candidateRoot 'web\src\components\AccountModal.vue') -Raw -Encoding UTF8
$legacyStoreCandidate = Get-Content -LiteralPath (Join-Path $candidateRoot 'web\src\stores\wx-login.ts') -Raw -Encoding UTF8
$legacyPrimaryRetired = $accountModalCandidate.Contains('使用当前已登录微信') `
    -and $accountModalCandidate.Contains('windows_wechat') `
    -and -not $accountModalCandidate.Contains('useWxLoginStore') `
    -and $legacyStoreCandidate.Contains('旧微信扫码/8059 登录链路已退役') `
    -and -not $legacyStoreCandidate.Contains('127.0.0.1:8059')

$serviceAfter = Get-ServiceConfig -Name $ServiceName
$accountsHashAfter = Get-FileSha256 -Path $accountsPath
$prodClientHashAfter = Get-FileSha256 -Path $prodClient
$productionUntouched = ($serviceAfter.ProcessId -eq $servicePidBefore) `
    -and ($accountsHashAfter -eq $accountsHashBefore) `
    -and ($prodClientHashAfter -eq $prodClientHashBefore)

$safeToApply = $agent.Available `
    -and $agent.AppId -eq $expectedAppId `
    -and $clientSyntaxOk `
    -and $clientMarkersOk `
    -and $webConflicts -eq 0 `
    -and $buildPassed `
    -and $legacyPrimaryRetired `
    -and $productionUntouched

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-webui-closeout-audit-{0}.json" -f $stamp)
$report = [ordered]@{
    version = 1
    phase = 'wechat-webui-legacy-closeout-audit'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = [ordered]@{ head=$sourceHead; root=$projectRoot }
    production = [ordered]@{
        root=$productionRoot
        core=$productionCore
        head=$productionHead
        pidBefore=$servicePidBefore
        pidAfter=$serviceAfter.ProcessId
        servicePidUnchanged=($serviceAfter.ProcessId -eq $servicePidBefore)
        accountsJsonUnchanged=($accountsHashAfter -eq $accountsHashBefore)
        clientJsUnchanged=($prodClientHashAfter -eq $prodClientHashBefore)
    }
    ancestry = [ordered]@{ mergeBase=$mergeBase }
    provider = [ordered]@{ ready=$agent.Available; reason=$agent.Reason; appId=$agent.AppId; tokenPrinted=$false }
    clientCandidate = [ordered]@{
        status=$clientStatus
        path=$clientCandidate
        syntaxOk=$clientSyntaxOk
        markersOk=$clientMarkersOk
        sha256=(Get-FileSha256 -Path $clientCandidate)
    }
    web = [ordered]@{
        mergeResults=$mergeResults
        conflicts=$webConflicts
        buildDepsAvailable=$buildDepsAvailable
        buildPassed=$buildPassed
        legacyPrimaryRetired=$legacyPrimaryRetired
        stage=$stageWeb
        distReady=(Test-Path -LiteralPath (Join-Path $stageWeb 'dist\index.html') -PathType Leaf)
    }
    safety = [ordered]@{
        productionModified=$false
        far2FarmRestarted=$false
        rawCodePrinted=$false
        providerTokenPrinted=$false
    }
    safeToApply=$safeToApply
}
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ("Source HEAD: {0}" -f $sourceHead)
Write-Host ("Production HEAD: {0}" -f $productionHead)
Write-Host ("Merge base: {0}" -f $mergeBase)
Write-Host ("Resident Agent ready: {0} ({1})" -f $agent.Available, $agent.Reason)
Write-Host ("client.js candidate: {0}, syntax={1}, markers={2}" -f $clientStatus, $clientSyntaxOk, $clientMarkersOk)
foreach ($item in $mergeResults) {
    $state = if ($item.conflict) { 'CONFLICT' } else { 'clean' }
    Write-Host ("Web merge [{0}]: {1}" -f $state, $item.path)
}
Write-Host ("Web build dependencies available: {0}" -f $buildDepsAvailable)
Write-Host ("Web build passed: {0}" -f $buildPassed)
Write-Host ("Legacy 8059 primary path retired in candidate: {0}" -f $legacyPrimaryRetired)
Write-Host ("Production untouched: {0}" -f $productionUntouched)
Write-Host ("Safe for controlled closeout apply: {0}" -f $safeToApply)
Write-Host ''
Write-Host 'Audit workspace:'
Write-Host $auditRoot
Write-Host ''
Write-Host 'Report path:'
Write-Host $reportPath
Write-Host ''

if ($safeToApply) {
    Write-Host 'WeChat WebUI / legacy closeout audit PASSED. Do not restart FAR2Farm yet.' -ForegroundColor Green
    exit 0
}
Write-Host 'WeChat WebUI / legacy closeout audit needs handling before apply.' -ForegroundColor Yellow
exit 2
