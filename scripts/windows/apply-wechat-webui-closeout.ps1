param(
    [string]$ServiceName = 'FAR2Farm',
    [string]$BaseUrl = 'http://127.0.0.1:3007',
    [string]$Username = 'admin'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$workBase = Join-Path $env:LOCALAPPDATA 'FAR2\wechat-webui-closeout-apply'
$backupBase = Join-Path $env:LOCALAPPDATA 'FAR2\wechat-webui-closeout-backup'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$workRoot = Join-Path $workBase $stamp
$stageWeb = Join-Path $workRoot 'web'
$candidateClient = Join-Path $workRoot 'client.js'
$backupRoot = Join-Path $backupBase $stamp
$expectedAppId = 'wx5306c5978fdb76e4'
$mutated = $false
$serviceRestarted = $false
$rollbackAttempted = $false
$rollbackSucceeded = $false

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

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $enc = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($Path, $Text, $enc)
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

function SecureString-ToPlain {
    param([Security.SecureString]$Secure)
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Json {
    param(
        [string]$Method,
        [string]$Uri,
        [hashtable]$Headers = @{},
        [object]$Body = $null,
        [int]$TimeoutSec = 12
    )
    $args = @{
        Method = $Method
        Uri = $Uri
        Headers = $Headers
        TimeoutSec = $TimeoutSec
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $args.ContentType = 'application/json; charset=utf-8'
        $args.Body = ($Body | ConvertTo-Json -Compress -Depth 8)
    }
    return Invoke-RestMethod @args
}

function Login-Admin {
    param([string]$Base, [string]$User, [string]$Password)
    $login = Invoke-Json -Method Post -Uri "$Base/api/login" -Body @{ username=$User; password=$Password }
    if (-not $login.ok -or -not $login.data -or [string]::IsNullOrWhiteSpace([string]$login.data.token)) {
        throw 'FAR2 admin login failed.'
    }
    if ([string]$login.data.role -ne 'admin') { throw 'The supplied FAR2 user is not an administrator.' }
    return [string]$login.data.token
}

function Get-AccountSnapshot {
    param([string]$Base, [string]$Token)
    $headers = @{ 'x-admin-token'=$Token; Accept='application/json'; 'Cache-Control'='no-store' }
    $res = Invoke-Json -Method Get -Uri "$Base/api/accounts" -Headers $headers
    if (-not $res.ok -or -not $res.data) { throw 'Could not read FAR2 accounts.' }
    $items = @($res.data.accounts)
    return @($items | ForEach-Object {
        [pscustomobject]@{
            id = [string]$_.id
            platform = [string]$_.platform
            username = [string]$_.username
            name = [string]$_.name
            running = ($_.running -eq $true)
        }
    } | Sort-Object id)
}

function Same-AccountIdentity {
    param([object[]]$Before, [object[]]$After)
    if (@($Before).Count -ne @($After).Count) { return $false }
    $left = @($Before | ForEach-Object { "{0}|{1}|{2}" -f $_.id,$_.platform,$_.username } | Sort-Object)
    $right = @($After | ForEach-Object { "{0}|{1}|{2}" -f $_.id,$_.platform,$_.username } | Sort-Object)
    return (($left -join "`n") -eq ($right -join "`n"))
}

function Wait-ServiceRunning {
    param([string]$Name, [int]$OldPid, [int]$TimeoutSec = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        Start-Sleep -Milliseconds 750
        $svc = Get-ServiceConfig -Name $Name
        if ($svc.State -eq 'Running' -and $svc.ProcessId -gt 0 -and ($OldPid -le 0 -or $svc.ProcessId -ne $OldPid)) { return $svc }
    } while ((Get-Date) -lt $deadline)
    throw "$Name did not return to Running with a new PID within ${TimeoutSec}s."
}

function Restore-Backup {
    param([string]$ProductionCore, [string]$ProductionRoot, [string]$BackupRoot, [bool]$NeedRestart)
    $script:rollbackAttempted = $true
    try {
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'core\client.js') -Destination (Join-Path $ProductionCore 'client.js') -Force
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'web\src\components\AccountModal.vue') -Destination (Join-Path $ProductionRoot 'web\src\components\AccountModal.vue') -Force
        Copy-Item -LiteralPath (Join-Path $BackupRoot 'web\src\stores\wx-login.ts') -Destination (Join-Path $ProductionRoot 'web\src\stores\wx-login.ts') -Force
        $prodDist = Join-Path $ProductionRoot 'web\dist'
        if (Test-Path -LiteralPath $prodDist) { Remove-Item -LiteralPath $prodDist -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $prodDist | Out-Null
        & robocopy (Join-Path $BackupRoot 'web\dist') $prodDist /E /NFL /NDL /NJH /NJS /NP *> $null
        if ($LASTEXITCODE -gt 7) { throw "robocopy rollback dist failed with code $LASTEXITCODE" }
        if ($NeedRestart) {
            Restart-Service -Name $ServiceName -Force -ErrorAction Stop
            Wait-ServiceRunning -Name $ServiceName -OldPid 0 -TimeoutSec 45 | Out-Null
        }
        $script:rollbackSucceeded = $true
    } catch {
        $script:rollbackSucceeded = $false
    }
}

Write-Host ''
Write-Host 'FAR2 WeChat WebUI / Resident Closeout Controlled Apply' -ForegroundColor Cyan
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host 'This intentionally replaces ONLY the two legacy WeChat WebUI source files, plus a semantic client.js bridge and rebuilt web/dist.' -ForegroundColor DarkGray
Write-Host 'The dirty production tree is never reset/checked out/cleaned. A backup is taken before mutation.' -ForegroundColor DarkGray
Write-Host ''

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this command from an elevated Administrator PowerShell. No production files were modified.'
}

$service = Get-ServiceConfig -Name $ServiceName
if ($service.State -ne 'Running' -or $service.ProcessId -le 0) { throw "$ServiceName is not Running." }
$productionCore = $service.AppDirectory
$productionRoot = Split-Path -Parent $productionCore
if ([IO.Path]::GetFullPath($productionRoot).TrimEnd('\') -eq $projectRoot.TrimEnd('\')) { throw 'Probe worktree and production worktree unexpectedly match; refusing.' }
$node = Get-NodeExe -Service $service
$agent = Test-AgentHealth
if (-not $agent.Available -or $agent.AppId -ne $expectedAppId) {
    throw "Resident Agent is not ready for exact farm appId ($($agent.Reason)). No production files were modified."
}

$sourceAccountModal = Join-Path $projectRoot 'web\src\components\AccountModal.vue'
$sourceWxStore = Join-Path $projectRoot 'web\src\stores\wx-login.ts'
$prodAccountModal = Join-Path $productionRoot 'web\src\components\AccountModal.vue'
$prodWxStore = Join-Path $productionRoot 'web\src\stores\wx-login.ts'
$prodClient = Join-Path $productionCore 'client.js'
$prodDist = Join-Path $productionRoot 'web\dist'
foreach ($p in @($sourceAccountModal,$sourceWxStore,$prodAccountModal,$prodWxStore,$prodClient,$prodDist)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "Required path missing: $p" }
}

$base = $BaseUrl.TrimEnd('/')
try { Invoke-RestMethod -Method Get -Uri "$base/api/game-version" -TimeoutSec 8 -ErrorAction Stop | Out-Null }
catch { throw "FAR2 admin API is not reachable at $base. No production files were modified." }

$securePassword = Read-Host "FAR2 admin password for '$Username'" -AsSecureString
$password = SecureString-ToPlain -Secure $securePassword
if ([string]::IsNullOrWhiteSpace($password)) { throw 'Admin password is empty.' }
$tokenBefore = Login-Admin -Base $base -User $Username -Password $password
$accountsBefore = @(Get-AccountSnapshot -Base $base -Token $tokenBefore)
try { Invoke-Json -Method Post -Uri "$base/api/logout" -Headers @{ 'x-admin-token'=$tokenBefore } | Out-Null } catch {}
$tokenBefore = $null

$qqBefore = @($accountsBefore | Where-Object { ([string]$_.platform).ToLowerInvariant() -eq 'qq' }).Count
$wxBefore = @($accountsBefore | Where-Object { ([string]$_.platform).ToLowerInvariant() -eq 'wx' }).Count
if ($qqBefore -lt 2 -or $wxBefore -lt 1) { throw "Unexpected production account baseline: qq=$qqBefore wx=$wxBefore" }

New-Item -ItemType Directory -Force -Path $workRoot,$stageWeb,$backupRoot | Out-Null

# Build an isolated WebUI using production as the base, but intentionally make the two WeChat closeout files authoritative.
& robocopy (Join-Path $productionRoot 'web') $stageWeb /E /XD node_modules dist .git /NFL /NDL /NJH /NJS /NP *> $null
if ($LASTEXITCODE -gt 7) { throw "robocopy production web -> stage failed with code $LASTEXITCODE" }
Copy-Item -LiteralPath $sourceAccountModal -Destination (Join-Path $stageWeb 'src\components\AccountModal.vue') -Force
Copy-Item -LiteralPath $sourceWxStore -Destination (Join-Path $stageWeb 'src\stores\wx-login.ts') -Force

$accountModalText = Get-Content -LiteralPath (Join-Path $stageWeb 'src\components\AccountModal.vue') -Raw -Encoding UTF8
$wxStoreText = Get-Content -LiteralPath (Join-Path $stageWeb 'src\stores\wx-login.ts') -Raw -Encoding UTF8
if (-not $accountModalText.Contains('使用当前已登录微信') -or -not $accountModalText.Contains('windows_wechat')) { throw 'Resident AccountModal markers are missing.' }
if ($accountModalText.Contains('useWxLoginStore')) { throw 'Legacy wx-login store is still referenced by AccountModal.' }
if (-not $wxStoreText.Contains('旧微信扫码/8059 登录链路已退役')) { throw 'Legacy wx-login fail-closed marker is missing.' }
if ($accountModalText.Contains('127.0.0.1:8059') -or $wxStoreText.Contains('127.0.0.1:8059')) { throw 'Legacy 8059 remains in the new WebUI primary path.' }

$depsCandidates = @((Join-Path $projectRoot 'web\node_modules'), (Join-Path $productionRoot 'web\node_modules'))
$depsRoot = @($depsCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1)
if ($depsRoot.Count -ne 1) { throw 'Web build dependencies are unavailable. No production files were modified.' }
$stageNodeModules = Join-Path $stageWeb 'node_modules'
if (Test-Path -LiteralPath $stageNodeModules) { Remove-Item -LiteralPath $stageNodeModules -Recurse -Force }
New-Item -ItemType Junction -Path $stageNodeModules -Target $depsRoot[0] | Out-Null
$vueTsc = Join-Path $stageNodeModules 'vue-tsc\bin\vue-tsc.js'
$vite = Join-Path $stageNodeModules 'vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $vueTsc -PathType Leaf) -or -not (Test-Path -LiteralPath $vite -PathType Leaf)) { throw 'vue-tsc/vite build tools are unavailable.' }
Push-Location -LiteralPath $stageWeb
try {
    & $node $vueTsc -b
    if ($LASTEXITCODE -ne 0) { throw "vue-tsc failed with code $LASTEXITCODE" }
    & $node $vite build
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $stageWeb 'dist\index.html') -PathType Leaf)) { throw "vite build failed with code $LASTEXITCODE" }
} finally { Pop-Location }

# Recreate the already-audited semantic client.js bridge directly from the exact live production client.js.
$clientText = Get-Content -LiteralPath $prodClient -Raw -Encoding UTF8
$clientChanged = $false
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
    $clientChanged = $true
}
Write-Utf8NoBom -Path $candidateClient -Text $clientText
& $node --check $candidateClient *> $null
if ($LASTEXITCODE -ne 0) { throw 'client.js semantic candidate failed Node syntax check.' }
if (-not $clientText.Contains('originalStartAccount') -or -not $clientText.Contains("triggerRefresh(id, 'web_enroll')")) { throw 'client.js semantic candidate markers are incomplete.' }

# Backup exactly what this deployment may replace.
New-Item -ItemType Directory -Force -Path (Join-Path $backupRoot 'core'),(Join-Path $backupRoot 'web\src\components'),(Join-Path $backupRoot 'web\src\stores'),(Join-Path $backupRoot 'web\dist') | Out-Null
Copy-Item -LiteralPath $prodClient -Destination (Join-Path $backupRoot 'core\client.js') -Force
Copy-Item -LiteralPath $prodAccountModal -Destination (Join-Path $backupRoot 'web\src\components\AccountModal.vue') -Force
Copy-Item -LiteralPath $prodWxStore -Destination (Join-Path $backupRoot 'web\src\stores\wx-login.ts') -Force
& robocopy $prodDist (Join-Path $backupRoot 'web\dist') /E /NFL /NDL /NJH /NJS /NP *> $null
if ($LASTEXITCODE -gt 7) { throw "robocopy production dist backup failed with code $LASTEXITCODE" }

$pidBefore = $service.ProcessId
$clientHashBefore = Get-FileSha256 -Path $prodClient
$modalHashBefore = Get-FileSha256 -Path $prodAccountModal
$storeHashBefore = Get-FileSha256 -Path $prodWxStore

try {
    Copy-Item -LiteralPath $candidateClient -Destination $prodClient -Force
    Copy-Item -LiteralPath $sourceAccountModal -Destination $prodAccountModal -Force
    Copy-Item -LiteralPath $sourceWxStore -Destination $prodWxStore -Force
    if (Test-Path -LiteralPath $prodDist) { Remove-Item -LiteralPath $prodDist -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $prodDist | Out-Null
    & robocopy (Join-Path $stageWeb 'dist') $prodDist /E /NFL /NDL /NJH /NJS /NP *> $null
    if ($LASTEXITCODE -gt 7) { throw "robocopy staged dist -> production failed with code $LASTEXITCODE" }
    $mutated = $true

    Restart-Service -Name $ServiceName -Force -ErrorAction Stop
    $serviceRestarted = $true
    $serviceAfterRestart = Wait-ServiceRunning -Name $ServiceName -OldPid $pidBefore -TimeoutSec 45

    $deadline = (Get-Date).AddSeconds(210)
    $accountsAfter = @()
    $allPreviouslyRunningRecovered = $false
    do {
        Start-Sleep -Seconds 5
        try {
            Invoke-RestMethod -Method Get -Uri "$base/api/game-version" -TimeoutSec 5 -ErrorAction Stop | Out-Null
            $tokenAfter = Login-Admin -Base $base -User $Username -Password $password
            $accountsAfter = @(Get-AccountSnapshot -Base $base -Token $tokenAfter)
            try { Invoke-Json -Method Post -Uri "$base/api/logout" -Headers @{ 'x-admin-token'=$tokenAfter } | Out-Null } catch {}
            $tokenAfter = $null
            if (Same-AccountIdentity -Before $accountsBefore -After $accountsAfter) {
                $beforeRunningIds = @($accountsBefore | Where-Object { $_.running } | ForEach-Object { $_.id })
                $afterRunningIds = @($accountsAfter | Where-Object { $_.running } | ForEach-Object { $_.id })
                $missing = @($beforeRunningIds | Where-Object { $afterRunningIds -notcontains $_ })
                $allPreviouslyRunningRecovered = ($missing.Count -eq 0)
                if ($allPreviouslyRunningRecovered) { break }
            }
        } catch {}
        $remaining = [math]::Max(0, [int](($deadline - (Get-Date)).TotalSeconds))
        Write-Host ("Waiting production workers to recover after closeout restart... remaining~{0}s" -f $remaining) -ForegroundColor DarkGray
    } while ((Get-Date) -lt $deadline)

    if (-not (Same-AccountIdentity -Before $accountsBefore -After $accountsAfter)) { throw 'Production account identity changed after closeout restart.' }
    if (-not $allPreviouslyRunningRecovered) { throw 'Not all previously running production workers recovered before timeout.' }

    $agentAfter = Test-AgentHealth
    if (-not $agentAfter.Available -or $agentAfter.AppId -ne $expectedAppId) { throw 'Resident Agent was not ready after closeout restart.' }

    $serviceFinal = Get-ServiceConfig -Name $ServiceName
    if ($serviceFinal.State -ne 'Running' -or $serviceFinal.ProcessId -le 0) { throw 'FAR2Farm is not running after closeout apply.' }

    $clientHashAfter = Get-FileSha256 -Path $prodClient
    $modalHashAfter = Get-FileSha256 -Path $prodAccountModal
    $storeHashAfter = Get-FileSha256 -Path $prodWxStore
    $qqAfter = @($accountsAfter | Where-Object { ([string]$_.platform).ToLowerInvariant() -eq 'qq' }).Count
    $wxAfter = @($accountsAfter | Where-Object { ([string]$_.platform).ToLowerInvariant() -eq 'wx' }).Count

    New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
    $reportPath = Join-Path $reportRoot ("wechat-webui-closeout-apply-{0}.json" -f $stamp)
    $report = [ordered]@{
        version = 1
        phase = 'wechat-webui-resident-closeout-controlled-apply'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        production = [ordered]@{
            serviceName = $ServiceName
            root = $productionRoot
            pidBefore = $pidBefore
            pidAfter = $serviceFinal.ProcessId
            restartedOnce = $serviceRestarted
            accountIdentityUnchanged = (Same-AccountIdentity -Before $accountsBefore -After $accountsAfter)
            qqBefore = $qqBefore
            qqAfter = $qqAfter
            wxBefore = $wxBefore
            wxAfter = $wxAfter
            previouslyRunningWorkersRecovered = $allPreviouslyRunningRecovered
        }
        web = [ordered]@{
            authoritativeFiles = @('web/src/components/AccountModal.vue','web/src/stores/wx-login.ts')
            isolatedBuildPassed = $true
            residentEntryPresent = $true
            legacy8059PrimaryRetired = $true
            distApplied = $true
            modalShaBefore = $modalHashBefore
            modalShaAfter = $modalHashAfter
            wxStoreShaBefore = $storeHashBefore
            wxStoreShaAfter = $storeHashAfter
        }
        client = [ordered]@{
            semanticBridgeChanged = $clientChanged
            syntaxPassed = $true
            clientShaBefore = $clientHashBefore
            clientShaAfter = $clientHashAfter
            webEnrollBridgePresent = $true
        }
        provider = [ordered]@{
            readyBefore = $agent.Available
            readyAfter = $agentAfter.Available
            appId = $expectedAppId
        }
        backup = [ordered]@{ path = $backupRoot }
        rollback = [ordered]@{ attempted=$rollbackAttempted; succeeded=$rollbackSucceeded }
        safety = [ordered]@{
            productionGitReset = $false
            productionGitCheckout = $false
            productionGitClean = $false
            rawCodePrinted = $false
            providerTokenPrinted = $false
            adminPasswordPrinted = $false
            adminTokenPrinted = $false
        }
        gatePassed = $true
    }
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8

    Write-Host ''
    Write-Host 'FAR2 WeChat WebUI / Resident closeout apply PASSED.' -ForegroundColor Green
    Write-Host ("FAR2Farm PID: {0} -> {1}" -f $pidBefore,$serviceFinal.ProcessId)
    Write-Host ("Production accounts: QQ {0}->{1}, WeChat {2}->{3}" -f $qqBefore,$qqAfter,$wxBefore,$wxAfter)
    Write-Host ("Previously running workers recovered: {0}" -f $allPreviouslyRunningRecovered) -ForegroundColor Green
    Write-Host 'WebUI primary WeChat path: current logged-in WeChat / Resident Agent' -ForegroundColor Green
    Write-Host 'Legacy 8059 primary path retired: True' -ForegroundColor Green
    Write-Host ("Resident Agent still ready: {0}" -f $agentAfter.Available) -ForegroundColor Green
    Write-Host ("Backup: {0}" -f $backupRoot)
    Write-Host ''
    Write-Host 'Report path:'
    Write-Host $reportPath
    Write-Host ''
} catch {
    $failure = $_.Exception.Message
    if ($mutated) {
        Write-Host ''
        Write-Host ("Closeout apply failed after mutation: {0}" -f $failure) -ForegroundColor Red
        Write-Host 'Attempting automatic rollback...' -ForegroundColor Yellow
        Restore-Backup -ProductionCore $productionCore -ProductionRoot $productionRoot -BackupRoot $backupRoot -NeedRestart $true
        Write-Host ("Rollback succeeded: {0}" -f $rollbackSucceeded) -ForegroundColor $(if ($rollbackSucceeded) { 'Green' } else { 'Red' })
    }
    throw $failure
} finally {
    $password = $null
    $securePassword = $null
}
