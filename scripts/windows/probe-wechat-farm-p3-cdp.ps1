param(
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ExpectedWmpfVersion = 25297
$DebuggerRepo = 'https://github.com/evi0s/WMPFDebugger.git'
$DebuggerCommit = '2b90b77fc6f13dd18480cd07d7dd9c052cc26c9d'
$DebugPort = 9421
$CdpPort = 62000
$FarmWindowTitle = 'QQ' + [char]0x7ECF + [char]0x5178 + [char]0x519C + [char]0x573A
$TempRoot = Join-Path $env:TEMP 'FAR2-WeChat-CDP'
$ReportRoot = Join-Path $env:TEMP 'FAR2-WeChat-Probe'

function Test-PortListening {
    param([int]$Port)
    try {
        return @((Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)).Count -gt 0
    }
    catch {
        return $false
    }
}

function Get-WmpfVersion {
    $versions = @()
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '(?i)^WeChatAppEx\.exe$' -and -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)
    } | ForEach-Object {
        $m = [regex]::Match([string]$_.ExecutablePath, '(?i)RadiumWMPF[\\/](\d+)[\\/]extracted')
        if ($m.Success) {
            $versions += [int]$m.Groups[1].Value
        }
    }
    $versions = @($versions | Sort-Object -Unique)
    if ($versions.Count -eq 0) { return $null }
    return [int]($versions | Sort-Object -Descending | Select-Object -First 1)
}

function Test-FarmWindowOpen {
    try {
        $hits = @(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object {
            [string]$_.MainWindowTitle -eq $FarmWindowTitle
        })
        return $hits.Count -gt 0
    }
    catch {
        return $false
    }
}

function Get-Node22Path {
    $existing = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($existing) {
        try {
            $version = & $existing.Source -p "process.versions.node"
            $major = [int](([string]$version).Split('.')[0])
            if ($major -ge 22) {
                return [string]$existing.Source
            }
        }
        catch {}
    }

    $nodeHome = Join-Path $TempRoot 'node22'
    $cachedNode = Get-ChildItem -LiteralPath $nodeHome -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cachedNode) {
        try {
            $version = & $cachedNode.FullName -p "process.versions.node"
            $major = [int](([string]$version).Split('.')[0])
            if ($major -eq 22) { return [string]$cachedNode.FullName }
        }
        catch {}
    }

    Write-Host 'Node.js 22+ not found. Downloading an isolated official Node 22 build...' -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $nodeHome | Out-Null
    $baseUrl = 'https://nodejs.org/dist/latest-v22.x/'
    $sumsText = (Invoke-WebRequest -Uri ($baseUrl + 'SHASUMS256.txt') -UseBasicParsing).Content
    $match = [regex]::Match([string]$sumsText, '(?m)^([0-9a-fA-F]{64})\s+(node-v22\.[0-9.]+-win-x64\.zip)\s*$')
    if (-not $match.Success) { throw 'Unable to resolve latest Node 22 win-x64 package from nodejs.org.' }

    $expectedHash = $match.Groups[1].Value.ToLowerInvariant()
    $zipName = $match.Groups[2].Value
    $zipPath = Join-Path $nodeHome $zipName
    Invoke-WebRequest -Uri ($baseUrl + $zipName) -OutFile $zipPath -UseBasicParsing
    $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        throw 'Node 22 download SHA256 verification failed.'
    }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $nodeHome -Force
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    $node = Get-ChildItem -LiteralPath $nodeHome -Filter node.exe -File -Recurse | Select-Object -First 1
    if (-not $node) { throw 'Portable Node 22 extraction completed but node.exe was not found.' }
    return [string]$node.FullName
}

function Prepare-Debugger {
    param([string]$NodePath)

    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { throw 'git.exe is required for the isolated P3 debugger checkout.' }

    $debuggerDir = Join-Path $TempRoot 'WMPFDebugger-25297'
    if (-not (Test-Path -LiteralPath (Join-Path $debuggerDir '.git'))) {
        if (Test-Path -LiteralPath $debuggerDir) {
            Remove-Item -LiteralPath $debuggerDir -Recurse -Force
        }
        Write-Host 'Cloning isolated WMPF debugger checkout...' -ForegroundColor Yellow
        & $git.Source clone --no-checkout $DebuggerRepo $debuggerDir
        if ($LASTEXITCODE -ne 0) { throw 'Failed to clone WMPFDebugger.' }
    }

    & $git.Source -C $debuggerDir fetch origin $DebuggerCommit --depth 1
    if ($LASTEXITCODE -ne 0) { throw 'Failed to fetch pinned WMPFDebugger commit.' }
    & $git.Source -C $debuggerDir checkout --detach --force $DebuggerCommit
    if ($LASTEXITCODE -ne 0) { throw 'Failed to checkout pinned WMPFDebugger commit.' }

    $head = (& $git.Source -C $debuggerDir rev-parse HEAD).Trim()
    if ($head -ne $DebuggerCommit) { throw 'Pinned WMPFDebugger commit verification failed.' }

    $nodeDir = Split-Path -Parent $NodePath
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmCmd)) {
        $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    }
    if ([string]::IsNullOrWhiteSpace([string]$npmCmd) -or -not (Test-Path -LiteralPath $npmCmd)) {
        throw 'npm.cmd was not found for Node 22.'
    }

    $fridaModule = Join-Path $debuggerDir 'node_modules\frida'
    $tsNodeBin = Join-Path $debuggerDir 'node_modules\ts-node\dist\bin.js'
    if (-not (Test-Path -LiteralPath $fridaModule) -or -not (Test-Path -LiteralPath $tsNodeBin)) {
        Write-Host 'Installing isolated P3 debugger dependencies. This may take a few minutes...' -ForegroundColor Yellow
        Push-Location $debuggerDir
        try {
            & $npmCmd install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm install failed for isolated WMPF debugger.' }
        }
        finally {
            Pop-Location
        }
    }

    return $debuggerDir
}

function Send-CdpMessage {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [hashtable]$Message
    )
    $json = $Message | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $segment = [ArraySegment[byte]]::new($bytes)
    $Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Receive-CdpMessage {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [int]$TimeoutMs = 1200
    )

    $buffer = New-Object byte[] 262144
    $stream = New-Object IO.MemoryStream
    $cts = New-Object Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutMs)
    try {
        do {
            $segment = [ArraySegment[byte]]::new($buffer)
            $result = $Socket.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { return $null }
            if ($result.Count -gt 0) { $stream.Write($buffer, 0, $result.Count) }
        } while (-not $result.EndOfMessage)
        return [Text.Encoding]::UTF8.GetString($stream.ToArray())
    }
    catch [OperationCanceledException] {
        return $null
    }
    catch [Threading.Tasks.TaskCanceledException] {
        return $null
    }
    finally {
        $cts.Dispose()
        $stream.Dispose()
    }
}

$debuggerProcess = $null
$socket = $null
try {
    Write-Host ''
    Write-Host 'FAR2 WeChat Farm P3 CDP Probe' -ForegroundColor Cyan
    Write-Host '============================='
    Write-Host 'P2 is complete. P3 now checks only whether the farm JS context exposes wx / wx.login.'
    Write-Host 'P3 does NOT call wx.login and does NOT capture Code, Token, Cookie, chat data, or network payload.'
    Write-Host ''

    $wmpfVersion = Get-WmpfVersion
    if ($null -eq $wmpfVersion) { throw 'No running WeChatAppEx.exe WMPF runtime was found. Keep desktop WeChat logged in.' }
    if ([int]$wmpfVersion -ne $ExpectedWmpfVersion) {
        throw ("Unsupported WMPF version for this pinned P3 probe: found {0}, expected {1}." -f $wmpfVersion, $ExpectedWmpfVersion)
    }

    if (Test-FarmWindowOpen) {
        Write-Host 'QQ Classic Farm is currently open.' -ForegroundColor Yellow
        Write-Host 'Close ONLY the farm mini-program window now. Keep desktop WeChat logged in.'
        [void](Read-Host 'After the farm window is closed, press Enter')
        Start-Sleep -Milliseconds 600
        if (Test-FarmWindowOpen) { throw 'Farm window is still open. Close only the farm window and run P3 again.' }
    }

    if (Test-PortListening -Port $DebugPort) { throw ("Local port {0} is already in use." -f $DebugPort) }
    if (Test-PortListening -Port $CdpPort) { throw ("Local port {0} is already in use." -f $CdpPort) }

    New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $ReportRoot | Out-Null

    $nodePath = Get-Node22Path
    $nodeVersion = (& $nodePath -p "process.versions.node").Trim()
    Write-Host ("Node runtime: {0}" -f $nodeVersion)

    $debuggerDir = Prepare-Debugger -NodePath $nodePath
    $tsNodeBin = Join-Path $debuggerDir 'node_modules\ts-node\dist\bin.js'
    $entry = Join-Path $debuggerDir 'src\index.ts'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $TempRoot ("wmpf-debugger-{0}.out.log" -f $stamp)
    $stderrLog = Join-Path $TempRoot ("wmpf-debugger-{0}.err.log" -f $stamp)

    Write-Host 'Starting isolated WMPF CDP bridge...' -ForegroundColor Yellow
    $debuggerProcess = Start-Process -FilePath $nodePath -ArgumentList @(
        $tsNodeBin,
        $entry,
        '--debug-port', [string]$DebugPort,
        '--cdp-port', [string]$CdpPort
    ) -WorkingDirectory $debuggerDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        if ($debuggerProcess.HasExited) { break }
        if ((Test-PortListening -Port $DebugPort) -and (Test-PortListening -Port $CdpPort)) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        $errTail = ''
        if (Test-Path -LiteralPath $stderrLog) {
            $errTail = ((Get-Content -LiteralPath $stderrLog -Tail 12 -ErrorAction SilentlyContinue) -join ' | ')
        }
        throw ("WMPF CDP bridge did not become ready. {0}" -f $errTail)
    }

    Write-Host ''
    Write-Host 'CDP bridge is ready.' -ForegroundColor Green
    Write-Host 'Now open QQ Classic Farm from desktop WeChat.' -ForegroundColor Green
    Write-Host 'Wait until the farm home screen is fully loaded.'
    [void](Read-Host 'Then return here and press Enter')
    Start-Sleep -Seconds 2

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $uri = [Uri]("ws://127.0.0.1:{0}" -f $CdpPort)
    $socket.ConnectAsync($uri, [Threading.CancellationToken]::None).GetAwaiter().GetResult()

    Send-CdpMessage -Socket $socket -Message @{ id = 1; method = 'Runtime.enable'; params = @{} }

    $contexts = @{}
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        $raw = Receive-CdpMessage -Socket $socket -TimeoutMs 800
        if ([string]::IsNullOrWhiteSpace([string]$raw)) { continue }
        try { $msg = $raw | ConvertFrom-Json } catch { continue }
        if ([string]$msg.method -eq 'Runtime.executionContextCreated' -and $msg.params -and $msg.params.context) {
            $ctx = $msg.params.context
            $contexts[[int]$ctx.id] = [pscustomobject][ordered]@{
                id = [int]$ctx.id
                name = [string]$ctx.name
                origin = [string]$ctx.origin
            }
        }
    }

    $contextList = @($contexts.Values | Sort-Object id | Select-Object -First 48)
    if ($contextList.Count -eq 0) {
        throw 'CDP connected but no Runtime execution contexts were reported.'
    }

    $pending = @{}
    $nextId = 100
    $expression = "(() => { let hasWx=false, hasLogin=false; try { hasWx=(typeof globalThis.wx==='object' && globalThis.wx!==null); hasLogin=(hasWx && typeof globalThis.wx.login==='function'); } catch(e) {} return {hasWx,hasLogin}; })()"
    foreach ($ctx in $contextList) {
        $requestId = $nextId
        $nextId++
        $pending[$requestId] = [int]$ctx.id
        Send-CdpMessage -Socket $socket -Message @{
            id = $requestId
            method = 'Runtime.evaluate'
            params = @{
                expression = $expression
                contextId = [int]$ctx.id
                returnByValue = $true
                awaitPromise = $false
                silent = $true
            }
        }
    }

    $evalResults = @{}
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and $evalResults.Count -lt $pending.Count) {
        $raw = Receive-CdpMessage -Socket $socket -TimeoutMs 800
        if ([string]::IsNullOrWhiteSpace([string]$raw)) { continue }
        try { $msg = $raw | ConvertFrom-Json } catch { continue }
        if ($null -eq $msg.id) { continue }
        $responseId = [int]$msg.id
        if (-not $pending.ContainsKey($responseId)) { continue }
        $ctxId = [int]$pending[$responseId]
        $hasWx = $false
        $hasLogin = $false
        $ok = $false
        if ($msg.result -and $msg.result.result -and $msg.result.result.value) {
            $value = $msg.result.result.value
            $hasWx = [bool]$value.hasWx
            $hasLogin = [bool]$value.hasLogin
            $ok = $true
        }
        $evalResults[$ctxId] = [pscustomobject][ordered]@{
            ok = $ok
            hasWx = $hasWx
            hasLogin = $hasLogin
        }
    }

    $rows = @()
    foreach ($ctx in $contextList) {
        $result = $null
        if ($evalResults.ContainsKey([int]$ctx.id)) { $result = $evalResults[[int]$ctx.id] }
        $rows += [pscustomobject][ordered]@{
            contextId = [int]$ctx.id
            name = [string]$ctx.name
            origin = [string]$ctx.origin
            evaluationOk = if ($null -ne $result) { [bool]$result.ok } else { $false }
            hasWx = if ($null -ne $result) { [bool]$result.hasWx } else { $false }
            hasWxLogin = if ($null -ne $result) { [bool]$result.hasLogin } else { $false }
        }
    }

    $wxRows = @($rows | Where-Object { $_.hasWx })
    $loginRows = @($rows | Where-Object { $_.hasWxLogin })

    $report = [ordered]@{
        version = 1
        phase = 'wechat-farm-p3-cdp-context'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        safety = [ordered]@{
            readOnly = $true
            wxLoginCalled = $false
            loginCodeCaptured = $false
            tokenOrCookieCaptured = $false
            chatDatabaseRead = $false
            networkPayloadCaptured = $false
            debuggerRunsFromTempOnly = $true
        }
        environment = [ordered]@{
            wmpfVersion = $wmpfVersion
            nodeVersion = $nodeVersion
            debuggerRepository = 'evi0s/WMPFDebugger'
            debuggerCommit = $DebuggerCommit
            debugPort = $DebugPort
            cdpPort = $CdpPort
        }
        summary = [ordered]@{
            executionContextCount = @($rows).Count
            wxContextCount = @($wxRows).Count
            wxLoginContextCount = @($loginRows).Count
            gatePassed = (@($loginRows).Count -gt 0)
        }
        contexts = $rows
    }

    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $OutputPath = Join-Path $ReportRoot ("wechat-farm-p3-cdp-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    $utf8NoBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($OutputPath, ($report | ConvertTo-Json -Depth 12), $utf8NoBom)

    Write-Host ''
    Write-Host 'P3 capture completed.' -ForegroundColor Green
    Write-Host ("Execution contexts: {0}" -f $report.summary.executionContextCount)
    Write-Host ("Contexts exposing wx: {0}" -f $report.summary.wxContextCount)
    Write-Host ("Contexts exposing wx.login: {0}" -f $report.summary.wxLoginContextCount)
    Write-Host ("P3 Gate passed: {0}" -f $report.summary.gatePassed)
    Write-Host ''
    Write-Host 'Report path:' -ForegroundColor Cyan
    Write-Host $OutputPath
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'P3 probe failed.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
finally {
    if ($null -ne $socket) {
        try {
            if ($socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
                $socket.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            }
        }
        catch {}
        try { $socket.Dispose() } catch {}
    }
    if ($null -ne $debuggerProcess) {
        try {
            if (-not $debuggerProcess.HasExited) {
                Stop-Process -Id $debuggerProcess.Id -Force -ErrorAction SilentlyContinue
            }
        }
        catch {}
    }
}
