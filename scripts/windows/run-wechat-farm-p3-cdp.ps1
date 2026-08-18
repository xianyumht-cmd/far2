param(
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$sourcePath = Join-Path $PSScriptRoot 'probe-wechat-farm-p3-cdp.ps1'
if (-not (Test-Path -LiteralPath $sourcePath)) {
    Write-Host 'P3 source probe was not found.' -ForegroundColor Red
    exit 1
}

$source = [IO.File]::ReadAllText($sourcePath)
$replacements = [ordered]@{
    '        & $git.Source clone --no-checkout $DebuggerRepo $debuggerDir' = '        & $git.Source clone --no-checkout $DebuggerRepo $debuggerDir | Out-Host'
    '    & $git.Source -C $debuggerDir fetch origin $DebuggerCommit --depth 1' = '    & $git.Source -C $debuggerDir fetch origin $DebuggerCommit --depth 1 | Out-Host'
    '    & $git.Source -C $debuggerDir checkout --detach --force $DebuggerCommit' = '    & $git.Source -C $debuggerDir checkout --detach --force $DebuggerCommit | Out-Host'
    '            & $npmCmd install --no-audit --no-fund' = '            & $npmCmd install --no-audit --no-fund | Out-Host'
}

foreach ($entry in $replacements.GetEnumerator()) {
    if (-not $source.Contains([string]$entry.Key)) {
        Write-Host ('P3 runner compatibility patch no longer matches source: {0}' -f $entry.Key.Trim()) -ForegroundColor Red
        exit 1
    }
    $source = $source.Replace([string]$entry.Key, [string]$entry.Value)
}

$tempRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$runtimeScript = Join-Path $tempRoot 'probe-wechat-farm-p3-cdp-runtime.ps1'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($runtimeScript, $source, $utf8NoBom)

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    & $runtimeScript
}
else {
    & $runtimeScript -OutputPath $OutputPath
}

exit $LASTEXITCODE
