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

# ClientWebSocket cancellation is destructive: cancelling ReceiveAsync changes the
# whole socket to Aborted. Keep a single pending ReceiveAsync across poll timeouts
# and wait on it without ever cancelling the operation.
$receivePattern = '(?s)function Receive-CdpMessage \{.*?\r?\n\}\r?\n\r?\n(?=\$debuggerProcess = \$null)'
$receiveReplacement = @'
function Receive-CdpMessage {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [int]$TimeoutMs = 1200
    )

    if ($Socket.State -ne [Net.WebSockets.WebSocketState]::Open) {
        throw ("CDP WebSocket is not open (state={0})." -f $Socket.State)
    }

    if (-not (Get-Variable -Name Far2CdpReceiveStream -Scope Script -ErrorAction SilentlyContinue)) {
        $script:Far2CdpReceiveStream = [IO.MemoryStream]::new()
        $script:Far2CdpPendingReceive = $null
        $script:Far2CdpReceiveBuffer = $null
    }

    $deadline = [Environment]::TickCount64 + [int64]$TimeoutMs
    while ([Environment]::TickCount64 -lt $deadline) {
        if ($null -eq $script:Far2CdpPendingReceive) {
            $script:Far2CdpReceiveBuffer = New-Object byte[] 262144
            $segment = [ArraySegment[byte]]::new($script:Far2CdpReceiveBuffer)
            $script:Far2CdpPendingReceive = $Socket.ReceiveAsync(
                $segment,
                [Threading.CancellationToken]::None
            )
        }

        $remaining64 = $deadline - [Environment]::TickCount64
        if ($remaining64 -le 0) { return $null }
        $remaining = [int][Math]::Min([int64][int]::MaxValue, $remaining64)

        # Task.Wait(timeout) does not cancel ReceiveAsync. If it times out, keep
        # the same task alive and continue waiting for it on the next poll.
        if (-not $script:Far2CdpPendingReceive.Wait($remaining)) {
            return $null
        }

        $result = $script:Far2CdpPendingReceive.GetAwaiter().GetResult()
        $script:Far2CdpPendingReceive = $null

        if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
            $script:Far2CdpReceiveStream.SetLength(0)
            return $null
        }

        if ($result.Count -gt 0) {
            $script:Far2CdpReceiveStream.Write($script:Far2CdpReceiveBuffer, 0, $result.Count)
        }

        if ($result.EndOfMessage) {
            $payload = [Text.Encoding]::UTF8.GetString($script:Far2CdpReceiveStream.ToArray())
            $script:Far2CdpReceiveStream.SetLength(0)
            return $payload
        }
    }

    return $null
}

'@
$patchedSource = [regex]::Replace($source, $receivePattern, $receiveReplacement, 1)
if ($patchedSource -eq $source) {
    Write-Host 'P3 runner compatibility patch could not replace Receive-CdpMessage.' -ForegroundColor Red
    exit 1
}
$source = $patchedSource

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
