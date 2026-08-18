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
    '    $Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()' = '    [void]$Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()'
    '    $socket.ConnectAsync($uri, [Threading.CancellationToken]::None).GetAwaiter().GetResult()' = '    [void]$socket.ConnectAsync($uri, [Threading.CancellationToken]::None).GetAwaiter().GetResult()'
    '                $socket.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, ''done'', [Threading.CancellationToken]::None).GetAwaiter().GetResult()' = '                [void]$socket.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, ''done'', [Threading.CancellationToken]::None).GetAwaiter().GetResult()'
    '        if ([string]$msg.method -eq ''Runtime.executionContextCreated'' -and $msg.params -and $msg.params.context) {' = '        if ($msg.PSObject.Properties[''method''] -and [string]$msg.method -eq ''Runtime.executionContextCreated'' -and $msg.PSObject.Properties[''params''] -and $msg.params -and $msg.params.PSObject.Properties[''context''] -and $msg.params.context) {'
    '                name = [string]$ctx.name' = '                name = if ($ctx.PSObject.Properties[''name'']) { [string]$ctx.name } else { '''' }'
    '                origin = [string]$ctx.origin' = '                origin = if ($ctx.PSObject.Properties[''origin'']) { [string]$ctx.origin } else { '''' }'
    '        if ($null -eq $msg.id) { continue }' = '        if (-not $msg.PSObject.Properties[''id'']) { continue }'
    '        if ($msg.result -and $msg.result.result -and $msg.result.result.value) {' = '        if ($msg.PSObject.Properties[''result''] -and $msg.result -and $msg.result.PSObject.Properties[''result''] -and $msg.result.result -and $msg.result.result.PSObject.Properties[''value''] -and $null -ne $msg.result.result.value) {'
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
