param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$implementation = Join-Path $PSScriptRoot 'apply-wechat-p8-production-runtime.ps1'
if (-not (Test-Path -LiteralPath $implementation -PathType Leaf)) {
    throw "Controlled apply implementation not found: $implementation"
}

# Keep the implementation next to this runner so its PSScriptRoot remains the repo's
# scripts/windows directory. Patch two compatibility details before execution:
# 1) OrderedDictionary reports are accepted without Hashtable coercion surprises.
# 2) node -e resolves production modules by absolute path, not the probe shell cwd.
$text = Get-Content -LiteralPath $implementation -Raw -Encoding UTF8

$oldReportParam = @'
function Write-Report {
    param([hashtable]$Report, [string]$Path)
'@
$newReportParam = @'
function Write-Report {
    param([object]$Report, [string]$Path)
'@

$oldDependency = @'
    $dependencyProbe = "process.chdir(" + (ConvertTo-Json $productionCore -Compress) + "); require('node-fetch'); require('ws'); require('./src/services/wechat-runtime-code-provider'); require('./src/services/wechat-recovery-manager'); require('./src/services/wechat-gateway-profile');"
    & $node -e $dependencyProbe *> $null
'@
$newDependency = @'
    $productionCoreJson = ConvertTo-Json $productionCore -Compress
    $dependencyProbe = "const path=require('node:path'); const root=$productionCoreJson; require(path.join(root,'src/services/wechat-runtime-code-provider')); require(path.join(root,'src/services/wechat-recovery-manager')); require(path.join(root,'src/services/wechat-gateway-profile'));"
    & $node -e $dependencyProbe *> $null
'@

foreach ($pair in @(
    @($oldReportParam, $newReportParam),
    @($oldDependency, $newDependency)
)) {
    if (-not $text.Contains([string]$pair[0])) {
        throw 'Controlled apply compatibility patch no longer matches implementation. Refusing partial execution.'
    }
    $text = $text.Replace([string]$pair[0], [string]$pair[1])
}

$tempScript = Join-Path $PSScriptRoot (".apply-wechat-p8-production-runtime-fixed-{0}-{1}.ps1" -f $PID, (Get-Date).ToString('yyyyMMddHHmmssfff'))
Set-Content -LiteralPath $tempScript -Value $text -Encoding UTF8
$hostExe = (Get-Process -Id $PID -ErrorAction Stop).Path
try {
    & $hostExe -NoProfile -ExecutionPolicy Bypass -File $tempScript -ServiceName $ServiceName
    $code = $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}
exit $code
