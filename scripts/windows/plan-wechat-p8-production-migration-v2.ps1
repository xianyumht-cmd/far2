param(
    [string]$ServiceName = 'FAR2Farm'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$legacyScript = Join-Path $PSScriptRoot 'plan-wechat-p8-production-migration.ps1'
if (-not (Test-Path -LiteralPath $legacyScript -PathType Leaf)) {
    throw "Migration audit implementation not found: $legacyScript"
}

# The production/probe worktrees may legitimately be in detached-HEAD state.
# `git branch --show-current` returns no output in that case. Under StrictMode,
# calling .Trim() directly on that null output aborts the read-only audit before
# it has inspected anything. Patch only those scalar git reads into a temporary
# copy; the production worktree/data/service remain untouched.
$text = Get-Content -LiteralPath $legacyScript -Raw -Encoding UTF8

$oldHead = @'
    $head = (& $Git -C $Root rev-parse HEAD 2>$null).Trim()
'@
$newHead = @'
    $headOutput = @(& $Git -C $Root rev-parse HEAD 2>$null)
    $head = if ($headOutput.Count -gt 0 -and $null -ne $headOutput[0]) { ([string]$headOutput[0]).Trim() } else { '' }
'@

$oldBranch = @'
    $branch = (& $Git -C $Root branch --show-current 2>$null).Trim()
'@
$newBranch = @'
    $branchOutput = @(& $Git -C $Root branch --show-current 2>$null)
    $branch = if ($branchOutput.Count -gt 0 -and $null -ne $branchOutput[0]) { ([string]$branchOutput[0]).Trim() } else { '(detached)' }
'@

$oldMergeBase = @'
$mergeBase = (& $git -C $projectRoot merge-base $production.Head $source.Head 2>$null).Trim()
'@
$newMergeBase = @'
$mergeBaseOutput = @(& $git -C $projectRoot merge-base $production.Head $source.Head 2>$null)
$mergeBase = if ($mergeBaseOutput.Count -gt 0 -and $null -ne $mergeBaseOutput[0]) { ([string]$mergeBaseOutput[0]).Trim() } else { '' }
'@

foreach ($pair in @(
    @($oldHead, $newHead),
    @($oldBranch, $newBranch),
    @($oldMergeBase, $newMergeBase)
)) {
    if (-not $text.Contains([string]$pair[0])) {
        throw 'Migration audit compatibility patch no longer matches the implementation. Refusing to run a partially patched audit.'
    }
    $text = $text.Replace([string]$pair[0], [string]$pair[1])
}

$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$tempScript = Join-Path $tempRoot ("plan-wechat-p8-production-migration-fixed-{0}-{1}.ps1" -f $PID, (Get-Date).ToString('yyyyMMddHHmmssfff'))
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
