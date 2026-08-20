param(
    [string]$BaseUrl = 'http://127.0.0.1:3007',
    [string]$Username = 'admin',
    [string]$AccountId = '3'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$reportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$expectedAppId = 'wx5306c5978fdb76e4'
# Construct 微信农场 from Unicode code points so the file works even under legacy console code pages.
$targetName = -join ([char[]]@(0x5FAE,0x4FE1,0x519C,0x573A))

function Get-ServicePid {
    $svc = Get-CimInstance Win32_Service -Filter "Name='FAR2Farm'" -ErrorAction Stop
    if ([string]$svc.State -ne 'Running' -or [int]$svc.ProcessId -le 0) {
        throw 'FAR2Farm is not running.'
    }
    return [int]$svc.ProcessId
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
        [object]$Body = $null
    )
    $args = @{
        Method = $Method
        Uri = $Uri
        Headers = $Headers
        TimeoutSec = 10
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $args.ContentType = 'application/json; charset=utf-8'
        $args.Body = ($Body | ConvertTo-Json -Compress -Depth 8)
    }
    return Invoke-RestMethod @args
}

Write-Host ''
Write-Host 'FAR2 WeChat Production Account Name Repair' -ForegroundColor Cyan
Write-Host '===========================================' -ForegroundColor Cyan
Write-Host 'This uses the running FAR2 admin API. FAR2Farm is NOT restarted.' -ForegroundColor DarkGray
Write-Host 'Only the WeChat account display name is changed; Code/recovery fields are not sent.' -ForegroundColor DarkGray
Write-Host ''

$pidBefore = Get-ServicePid
$base = $BaseUrl.TrimEnd('/')

# Prove the local admin API is reachable before asking for a password.
try {
    $ping = Invoke-RestMethod -Method Get -Uri "$base/api/game-version" -TimeoutSec 8 -ErrorAction Stop
} catch {
    throw "FAR2 admin API is not reachable at $base. No account data was changed."
}

$securePassword = Read-Host "FAR2 admin password for '$Username'" -AsSecureString
$password = SecureString-ToPlain -Secure $securePassword
if ([string]::IsNullOrWhiteSpace($password)) { throw 'Admin password is empty.' }

$token = ''
try {
    $login = Invoke-Json -Method Post -Uri "$base/api/login" -Body @{ username=$Username; password=$password }
    if (-not $login.ok -or -not $login.data -or [string]::IsNullOrWhiteSpace([string]$login.data.token)) {
        throw 'FAR2 admin login failed.'
    }
    if ([string]$login.data.role -ne 'admin') { throw 'The supplied FAR2 user is not an administrator.' }
    $token = [string]$login.data.token
} finally {
    $password = $null
    $securePassword = $null
}

$headers = @{ 'x-admin-token' = $token; Accept='application/json'; 'Cache-Control'='no-store' }
$before = Invoke-Json -Method Get -Uri "$base/api/accounts" -Headers $headers
if (-not $before.ok -or -not $before.data) { throw 'Could not read FAR2 accounts before rename.' }
$accounts = @($before.data.accounts)
$target = $accounts | Where-Object { [string]$_.id -eq [string]$AccountId } | Select-Object -First 1
if (-not $target) { throw "Account id $AccountId was not found." }
if (([string]$target.platform).ToLowerInvariant() -ne 'wx') { throw "Account id $AccountId is not platform=wx; refusing rename." }
if ($target.PSObject.Properties.Name -contains 'wechatAppId') {
    $storedAppId = [string]$target.wechatAppId
    if ($storedAppId -and $storedAppId -ne $expectedAppId) { throw "WeChat account appId mismatch; refusing rename." }
}

$beforeName = [string]$target.name
$rename = Invoke-Json -Method Post -Uri "$base/api/account/remark" -Headers $headers -Body @{ id=[string]$AccountId; remark=$targetName }
if (-not $rename.ok) { throw 'FAR2 account remark update failed.' }

$after = Invoke-Json -Method Get -Uri "$base/api/accounts" -Headers $headers
if (-not $after.ok -or -not $after.data) { throw 'Could not verify FAR2 accounts after rename.' }
$afterTarget = @($after.data.accounts) | Where-Object { [string]$_.id -eq [string]$AccountId } | Select-Object -First 1
if (-not $afterTarget) { throw 'WeChat account disappeared after rename.' }
$nameOk = ([string]$afterTarget.name -eq $targetName)
if (-not $nameOk) { throw 'WeChat account display name did not persist correctly.' }

$pidAfter = Get-ServicePid
if ($pidAfter -ne $pidBefore) { throw 'FAR2Farm PID changed during display-name repair.' }

# Best-effort logout; never print/store the token.
try { Invoke-Json -Method Post -Uri "$base/api/logout" -Headers $headers | Out-Null } catch {}
$token = $null

New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ("wechat-production-account-name-repair-{0}.json" -f $stamp)
$report = [ordered]@{
    version = 1
    phase = 'wechat-production-account-display-name-repair'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    production = [ordered]@{
        serviceName = 'FAR2Farm'
        servicePidBefore = $pidBefore
        servicePidAfter = $pidAfter
        servicePidUnchanged = ($pidBefore -eq $pidAfter)
    }
    account = [ordered]@{
        id = [string]$AccountId
        platform = 'wx'
        appId = $expectedAppId
        beforeName = $beforeName
        afterName = $targetName
        changed = ($beforeName -ne $targetName)
        verified = $nameOk
    }
    safety = [ordered]@{
        far2FarmRestarted = $false
        codeFieldSent = $false
        recoveryFieldsSent = $false
        rawCodePrinted = $false
        adminPasswordPrinted = $false
        adminTokenPrinted = $false
    }
    gatePassed = $true
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ("WeChat account id: {0}" -f $AccountId)
Write-Host ("Display name repaired: {0}" -f $nameOk) -ForegroundColor Green
Write-Host ("FAR2Farm PID unchanged: {0}" -f ($pidBefore -eq $pidAfter)) -ForegroundColor Green
Write-Host 'Code/recovery fields sent: False' -ForegroundColor Green
Write-Host 'FAR2Farm restarted: False' -ForegroundColor Green
Write-Host ''
Write-Host 'Report path:'
Write-Host $reportPath
Write-Host ''
Write-Host 'WeChat production account name repair PASSED.' -ForegroundColor Green
